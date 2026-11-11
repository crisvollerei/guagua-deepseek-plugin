import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MemoryStore, MemoryService, MEMORY_RULES, sessionKey, normalizeId, parseJsonObject } from '../guagua-memory.mjs';
import { WebService, WEB_TOOLS, WEB_RULES } from '../guagua-web.mjs';
import { ReplyDelivery, QuotedContinuation, REPLY_RULES, planReply, prefersSingleReply } from '../guagua-reply.mjs';
import { ConversationListening } from '../guagua-listen.mjs';
import { GifContactSheet } from '../guagua-vision.mjs';
import { FakeClock } from './fake-clock.mjs';
import { tinyGif, rgbaFrames } from './vision-fixtures.mjs';

import { profile, message, deferred, turn, pluginHarness, quotedHarness } from './plugin-harness.mjs';

const quiet = { info() {}, warn() {}, error() {} };

function directory(t) {
    const base = fileURLToPath(new URL('./.tmp/', import.meta.url));
    fs.mkdirSync(base, { recursive: true });
    const root = fs.mkdtempSync(path.join(base, 'guagua-memory-test-'));
    t.after(() => {
        const absolute = path.resolve(root);
        assert.equal(path.dirname(absolute), path.resolve(base));
        assert.ok(path.basename(absolute).startsWith('guagua-memory-test-'));
        fs.rmSync(absolute, { recursive: true, force: true });
    });
    return root;
}

function setup(t, options = {}) {
    const root = directory(t);
    let time = Date.parse('2026-10-16T02:00:00Z');
    const service = new MemoryService({ directory: root, getProfile: () => profile, logger: quiet,
        now: () => time, complete: options.complete || (async () => message({ memories: [] })) });
    t.after(() => service.dispose());
    return { root, service, store: service.store, advance: ms => { time += ms; }, now: () => time };
}

function source(text = '我养了一只橘猫，名字叫豆包', overrides = {}) {
    return { id: 'source-1', speakerId: '33333', groupId: '99999', session: '12345:group:99999', name: '群员', at: '2026-10-16T02:00:00.000Z', text, targets: [], ...overrides };
}

function pet(overrides = {}) {
    return { type: 'entity', userid: '33333', content: '养了一只名叫豆包的橘猫', assertion: 'affirmed', scope: 'global', source_id: 'source-1', evidence: '我养了一只橘猫，名字叫豆包',
        entity: { name: '豆包', kind: '猫', relation: '宠物', attributes: '橘猫' }, ...overrides };
}

// 分页和管理用例直接准备已存记录；虚构展示正文不经过原话证据提取。
function seedReview(service, records, sources = [source()]) {
    service.store.change(data => {
        for (const raw of records) {
            const s = sources.find(item => item.id === raw.source_id) || sources[0];
            const temporary = ['event', 'agreement'].includes(raw.type);
            const local = temporary || raw.type === 'alias' || raw.scope !== 'global';
            const scope = local ? (s.groupId ? { kind: 'group', groupId: s.groupId } : { kind: 'private', sessionId: s.session }) : { kind: 'person' };
            data.people[raw.userid] ||= { name: raw.userid };
            service.store.addTo(data, { type: raw.type, subjectId: raw.userid, content: raw.content, entity: raw.entity,
                scope, status: temporary ? 'active' : 'pending',
                ...(temporary ? { expiresAt: new Date(service.store.now() + 86400000).toISOString() } : {}),
                source: { speakerId: s.speakerId, messageId: s.id, groupId: s.groupId, session: s.session, at: s.at, quote: s.text } });
        }
    });
}

function present(service, groupId, ids = ['33333'], userIds = ids) {
    for (const user_id of ids) service.roster.noteMessage({ self_id: 12345, group_id: groupId, user_id, post_type: 'message' });
    return service.roster.context({ self_id: 12345, group_id: groupId }, userIds);
}
function recall(service, options, members = options.userIds || ['33333']) {
    return service.context({ ...(options.groupId ? present(service, options.groupId, members, options.userIds || []) : {}), ...options });
}

test('宠物关联保留主人、名称和特征，待确认可召回且不会变成既定事实', t => {
    const { service, store } = setup(t);
    service.ingest([pet()], [source()]);
    const record = store.data.records[0];
    assert.equal(record.subjectId, '33333');
    assert.equal(record.entity.relation, '宠物');
    assert.equal(record.entity.attributes, '橘猫');
    assert.equal(record.status, 'pending');
    const context = store.context({ ...present(service, 'other'), userIds: ['33333'], groupId: 'other', query: '豆包怎么样' });
    assert.match(context, /待确认参考（尚未核实，不得作为既定事实）/);
    assert.match(context, /豆包/);
    assert.doesNotMatch(context, /【已确认长期记忆】/);
    assert.ok(record.source.quote);
});

test('未收录成员能学习；不存在于原话的证据和凭空生成的userid不落库', t => {
    const { service, store } = setup(t);
    service.ingest([pet(), pet({ content: '假宠物', evidence: '不存在的原话' }), pet({ userid: '88888', content: '归错人' })], [source()]);
    assert.equal(store.data.records.length, 1);
    assert.equal(store.data.records[0].subjectId, '33333');
});

test('近期事件和约定免确认，具有期限，过期不召回也不进入待确认提醒', t => {
    const { service, store, advance } = setup(t);
    const s = source('明天去打疫苗，下周约好一起复习');
    service.ingest([
        pet({ type: 'event', content: '明天给宠物打疫苗', evidence: '明天去打疫苗', expires_at: '2026-10-18T23:59:59+08:00' }),
        pet({ type: 'agreement', content: '下周一起复习', evidence: '下周约好一起复习' })
    ], [s]);
    assert.equal(store.pending().length, 0);
    assert.ok(store.data.records.every(r => r.status === 'active' && r.expiresAt));
    assert.match(store.context({ ...present(service, '99999'), userIds: ['33333'], groupId: '99999' }), /免确认/);
    advance(40 * 86400000);
    store.cleanup();
    assert.ok(store.data.records.every(r => r.status === 'expired'));
    assert.equal(store.context({ ...present(service, '99999'), userIds: ['33333'], groupId: '99999' }), '');
});

test('同名事件过期后再次提起，使用新来源和新期限生效', t => {
    const { service, store, advance } = setup(t);
    const record = pet({ type: 'event', content: '给宠物打疫苗', evidence: '给宠物打疫苗' });
    service.ingest([record], [source('给宠物打疫苗')]);
    advance(15 * 86400000); store.cleanup();
    assert.equal(store.data.records[0].status, 'expired');
    const again = source('给宠物打疫苗', { id: 'source-2', at: new Date(store.now()).toISOString() });
    service.ingest([{ ...record, source_id: again.id }], [again]);
    assert.equal(store.data.records.length, 2);
    assert.equal(store.data.records[0].status, 'expired');
    assert.equal(store.data.records.at(-1).status, 'active');
    assert.equal(store.data.records.at(-1).source.messageId, again.id);
    assert.ok(Date.parse(store.data.records.at(-1).expiresAt) > store.now());
});

test('待确认称呼不能用于确定身份，确认后生效；群称呼不跨群', t => {
    const { service, store } = setup(t);
    service.ingest([pet({ type: 'alias', content: '瓜瓜', scope: 'group', evidence: '叫我瓜瓜' })], [source('叫我瓜瓜')]);
    const record = store.data.records[0];
    assert.deepEqual(store.aliases('33333', '99999'), []);
    store.manage('确认', record.id, '', '22222');
    assert.deepEqual(store.aliases('33333', '99999'), ['瓜瓜']);
    assert.deepEqual(store.aliases('33333', 'another'), []);
    assert.equal(store.search({ userIds: ['33333'], groupId: 'another' }).length, 0);
});

test('呼叫机器人不能变成人物称呼，缺少归属和改写成描述句的自动称呼不入库', t => {
    const { service, store } = setup(t);
    present(service, '99999', ['33333', '12345']);
    for (const sentence of ['呱瓜你看看', '笨瓜！', '#呱瓜，你在吗？', '大笨瓜说话']) {
        const s = source(sentence);
        service.ingest([
            pet({ type: 'alias', userid: '', content: '在群内被称呼为“呱瓜”（无法确认对应成员）', evidence: sentence }),
            pet({ type: 'alias', content: '呱瓜', evidence: sentence }),
            pet({ type: 'alias', userid: '', content: '呱瓜', evidence: sentence }),
            pet({ type: 'alias', userid: '12345', content: '呱瓜', evidence: sentence })
        ], [s]);
    }
    service.ingest([pet({ type: 'alias', userid: '', content: '小二', evidence: '那个人外号叫小二' })], [source('那个人外号叫小二')]);
    service.ingest([pet({ type: 'alias', content: '阿明的外号是小二', evidence: '大家叫我小二' })], [source('大家叫我小二')]);
    assert.equal(store.data.records.length, 0);
});

test('机器人名字可出现在真实成员自称和宠物信息里，不能按昵称一刀切过滤', t => {
    const { service, store } = setup(t);
    service.ingest([pet({ type: 'alias', content: '呱瓜', evidence: '我也叫呱瓜' })], [source('我也叫呱瓜')]);
    service.ingest([pet({ type: 'alias', content: '夜猫', evidence: '叫我夜猫' })], [source('呱瓜，以后叫我夜猫')]);
    service.ingest([pet({ evidence: '我养了一只橘猫，名字叫豆包' })], [source('呱瓜你看看，我养了一只橘猫，名字叫豆包')]);
    assert.deepEqual(store.data.records.slice(0, 2).map(r => [r.type, r.content]), [['alias', '呱瓜'], ['alias', '夜猫']]);
    assert.equal(store.data.records[2].type, 'entity');
    assert.equal(store.data.records[2].entity.name, '豆包');
    assert.match(store.data.records[2].content, /我养了一只橘猫，名字叫豆包/);
});

test('提取器收到机器人身份；即使机器人在当前群成员表中也不能建立其人物记忆', async t => {
    let captured;
    const { service, store, advance } = setup(t, { complete: async params => {
        captured = JSON.parse(params.messages[1].content);
        const s = captured.messages[0];
        return message({ memories: [{ type: 'alias', userid: s.botId, content: '呱瓜', scope: 'group', evidence: '呱瓜你看看', source_id: s.id }] });
    } });
    present(service, '99999', ['12345', '33333']);
    service.observe({ self_id: 12345, group_id: 99999, user_id: 33333, message_id: 'call', message: [] }, '呱瓜你看看');
    advance(31000); await service.processExtractions();
    assert.equal(captured.assistant.userid, '12345');
    assert.ok(captured.assistant.names.includes('呱瓜'));
    assert.equal(store.pending().length, 0);
    assert.equal(store.data.observations.length, 0);
});

test('启动时自动忽略明确的无归属机器人呼叫误项，保留编号来源和其他记忆且可重复加载', t => {
    const { service, store, root, now } = setup(t);
    const origin = { speakerId: '33333', messageId: '12345:group:99999:old', groupId: '99999', session: '12345:group:99999', at: '2026-11-07T10:12:10.000Z' };
    const seed = [
        { type: 'alias', subjectId: '', content: '在群内被称呼为“呱瓜”（无法确认对应成员）', status: 'pending', source: { ...origin, quote: '呱瓜你看看' } },
        { type: 'alias', subjectId: '33333', content: '呱瓜', status: 'pending', source: { ...origin, quote: '呱瓜' } },
        { type: 'alias', subjectId: '33333', content: '主人已确认的称呼', status: 'confirmed', source: { ...origin, quote: '呱瓜你看看' } },
        { type: 'alias', subjectId: '', content: '旧称呼待归属', status: 'pending', source: { quote: '', context: '旧资料' } },
        { type: 'entity', subjectId: '33333', content: '养了一只猫', status: 'pending', source: { ...origin, quote: '呱瓜你看看，我养了一只猫' } },
        { type: 'alias', subjectId: '12345', content: '呱瓜', status: 'pending', source: { ...origin, quote: '机器人叫呱瓜' } }
    ];
    store.change(data => { for (const record of seed) store.addTo(data, record); });
    const previous = JSON.parse(JSON.stringify(store.data)), nextId = store.data.nextId;
    service.dispose();
    const reloaded = new MemoryService({ directory: root, now, getProfile: () => profile, logger: quiet, complete: async () => message({ memories: [] }) });
    t.after(() => reloaded.dispose());
    assert.deepEqual(reloaded.store.data.records.map(r => r.status), ['ignored', 'pending', 'confirmed', 'pending', 'pending', 'ignored']);
    assert.equal(reloaded.store.data.nextId, nextId);
    for (let i = 0; i < seed.length; i++) {
        const record = reloaded.store.data.records[i];
        assert.equal(record.id, previous.records[i].id);
        assert.equal(record.content, previous.records[i].content);
        assert.deepEqual(record.source, previous.records[i].source);
    }
    assert.match(reloaded.store.data.records[0].reviewReason, /无归属的纯呼叫/);
    assert.equal(reloaded.store.usable(reloaded.store.data.records[0]), false);
    const saved = fs.readFileSync(reloaded.store.file, 'utf8');
    assert.equal(reloaded.retireInvalidAliases(), 0);
    assert.equal(fs.readFileSync(reloaded.store.file, 'utf8'), saved);
});

test('只有机器人呼叫误项时不再私聊提醒，不修改原有全量提醒模式', async t => {
    const { service, store, advance } = setup(t);
    store.setConfig({ reminderInitialDelaySeconds: 0 });
    store.change(data => store.addTo(data, { type: 'alias', subjectId: '', content: '被称呼为呱瓜', status: 'pending',
        source: { speakerId: '33333', session: '12345:group:99999', groupId: '99999', quote: '呱瓜你看看' } }));
    let sent = 0;
    service.registerBot({ uin: 12345, pickUser: () => ({ sendMsg: async () => { sent++; return true; } }) });
    await service.notifyPending();
    advance(6 * 3600000); await service.notifyPending();
    assert.equal(sent, 0);
    assert.equal(store.data.records[0].status, 'ignored');
    assert.equal(store.config.reminderMode, 'all');
});

test('其他机器人账号和机器人自己的原话不能写入人类资料，当前群内真人仍能学习', t => {
    const { service, store } = setup(t);
    service.registerBot({ uin: 54321 });
    present(service, '99999', ['12345', '54321', '33333']);
    assert.equal(service.observe({ self_id: 12345, group_id: 99999, user_id: 12345, message_id: 'bot-self', message: [] }, '我叫呱瓜'), undefined);
    assert.equal(store.data.observations.length, 0);
    assert.equal(store.data.people['12345'], undefined);
    service.ingest([pet({ userid: '12345' }), pet({ userid: '54321' })], [source()]);
    service.ingest([pet()], [source(undefined, { speakerId: '12345' })]);
    assert.equal(store.data.records.length, 0);
    service.ingest([pet()], [source()]);
    assert.equal(store.data.records.length, 1);
    assert.equal(store.data.records[0].subjectId, '33333');
});

test('兼容MEM入口也拒绝纯呼叫和缺少归属的新称呼，明确自称仍正常提取', t => {
    const { service, store } = setup(t);
    service.ingestMeta({ remember: [{ userid: '33333', alias: '呱瓜' }], pending: ['呱瓜'] }, [source('呱瓜你看看')]);
    assert.equal(store.data.records.length, 0);
    service.ingestMeta({ remember: [{ userid: '33333', alias: '夜猫' }] }, [source('以后叫我夜猫')]);
    assert.equal(store.data.records.length, 1);
    assert.equal(store.data.records[0].content, '夜猫');
    assert.equal(store.data.records[0].subjectId, '33333');
});

test('更正待确认时保留旧确认事实，确认更正后替代旧事实；忽略后不重复学习', t => {
    const { service, store } = setup(t);
    service.ingest([pet()], [source()]);
    const old = store.data.records[0];
    store.manage('确认', old.id, '', '22222');
    service.ingest([pet({ content: '豆包其实是狗', evidence: '豆包其实是狗', replaces: old.id })], [source('豆包其实是狗')]);
    const correction = store.data.records[1];
    assert.equal(store.data.records[0].status, 'confirmed');
    store.manage('确认', correction.id, '', '22222');
    assert.equal(store.data.records[0].status, 'superseded');
    store.manage('忽略', correction.id, '', '22222');
    service.ingest([pet({ content: '豆包其实是狗', evidence: '豆包其实是狗' })], [source('豆包其实是狗')]);
    assert.equal(store.data.records.length, 2);
    assert.equal(store.data.records[1].status, 'ignored');
});

test('旧learned保持确认状态，已解决pending不重复迁移，迁移可重复启动', t => {
    const { store } = setup(t);
    store.change(data => { data.migratedProfile = false; });
    const p = { users: { '33333': { name: '阿明', aliases: ['明明'], learned: [{ alias: '小明', at: '2026-10-01' }] } }, pending: [{ alias: '明明' }, { alias: '某人' }] };
    store.migrate(p);
    store.migrate(p);
    assert.equal(store.data.records.length, 2);
    assert.equal(store.data.records[0].status, 'confirmed');
    assert.equal(store.pending()[0].content, '某人');
});

test('记忆文件损坏时保留有效缓存并禁止覆盖；BOM可读取', t => {
    const { store, root } = setup(t);
    const count = store.data.records.length;
    fs.writeFileSync(store.file, '{broken');
    store.load();
    assert.throws(() => store.change(data => { data.records = []; }), /读取失败/);
    assert.equal(fs.readFileSync(store.file, 'utf8'), '{broken');
    assert.equal(store.data.records.length, count);
    fs.writeFileSync(store.file, '\ufeff' + JSON.stringify(store.data));
    const restored = new MemoryStore(root, { logger: quiet });
    assert.equal(restored.blocked, '');
});

test('保存失败不污染缓存；手动编辑后下一次写入先合并最新文件', t => {
    const { store } = setup(t);
    const write = store.write;
    store.write = () => { throw new Error('disk full'); };
    assert.throws(() => store.change(data => { data.people.unwritten = { name: 'never' }; }), /disk full/);
    assert.equal(store.data.people.unwritten, undefined);
    store.write = write;
    const changed = JSON.parse(fs.readFileSync(store.file, 'utf8'));
    changed.people.external = { name: 'manual external edit with different size' };
    fs.writeFileSync(store.file, JSON.stringify(changed, null, 2));
    store.change(data => { data.people.local = { name: 'local' }; });
    assert.ok(store.data.people.external);
    assert.ok(store.data.people.local);
});

test('近期上下文重启后恢复，长度0不读取也不继续积累', t => {
    const { store, root } = setup(t);
    store.appendHistory('s', [{ role: 'user', content: '我的猫' }, { role: 'assistant', content: '豆包呀' }], 3);
    const reopened = new MemoryStore(root, { logger: quiet });
    assert.equal(reopened.history('s', 3)[1].content, '豆包呀');
    assert.deepEqual(reopened.history('s', 0), []);
    reopened.appendHistory('s', [{ role: 'user', content: 'new' }], 0);
    assert.deepEqual(reopened.data.sessions.s.history, []);
});

test('摘要失败保留待处理原文，恢复后更新滚动摘要；重置阻止迟到摘要写回', async t => {
    let fail = true;
    const { service, store, advance } = setup(t, { complete: async () => { if (fail) throw Error('offline'); return message('userid=33333 提过宠物豆包。'); } });
    store.queueSummary('s', [{ content: 'userid=33333 我的猫豆包' }]);
    await service.processSummary('s');
    assert.equal(store.data.sessions.s.pendingSummary.length, 1);
    advance(61000); fail = false;
    await service.processSummary('s');
    assert.equal(store.data.sessions.s.pendingSummary.length, 0);
    assert.match(store.data.sessions.s.summary, /豆包/);
    const d = deferred(); service.complete = () => d.promise;
    const e = { self_id: 1, user_id: 33333 };
    const key = sessionKey(e);
    store.queueSummary(key, [{ content: 'old' }]);
    const pending = service.processSummary(key);
    service.reset(e); d.resolve(message('stale'));
    await pending;
    assert.equal(store.data.sessions[key], undefined);
});

test('提取失败保留消息并退避；成功提取宠物后清理队列', async t => {
    let fail = true;
    const { service, store, advance } = setup(t, { complete: async params => {
        if (fail) throw Error('offline');
        assert.match(params.messages[0].content, /宠物、物品、作品、项目、亲友/);
        const s = JSON.parse(params.messages[1].content).messages[0];
        return message({ memories: [pet({ source_id: s.id })] });
    } });
    const e = { self_id: 12345, group_id: 99999, user_id: 33333, message_id: 'pet', sender: { nickname: '新人' }, message: [] };
    service.observe(e, source().text);
    advance(31000);
    await service.processExtractions();
    assert.equal(store.data.observations.length, 1);
    assert.equal(store.data.observations[0].attempts, 1);
    fail = false; advance(61000);
    await service.processExtractions();
    assert.equal(store.data.observations.length, 0);
    assert.equal(store.data.records[0].entity.name, '豆包');
    assert.equal(store.data.people['33333'].name, '新人');
});

test('主人提醒展示全部待确认内容与原话，事件约定不进入提醒；间隔跨重启保留', async t => {
    const { service, store, root, advance, now } = setup(t);
    store.setConfig({ reminderPageSize: 2, reminderInitialDelaySeconds: 0 });
    seedReview(service, Array.from({ length: 5 }, (_, i) => pet({ content: `宠物资料${i}` })), [source()]);
    seedReview(service, [pet({ type: 'event', content: '临时事件' })], [source()]);
    const sent = [];
    service.registerBot({ uin: 12345, pickUser: uid => ({ sendMsg: async body => { sent.push({ uid, body }); return true; } }) });
    await service.notifyPending();
    assert.equal(sent.length, 3);
    assert.ok(sent.every(s => s.uid === '22222' && s.body.includes('原话：')));
    assert.match(sent.map(s => s.body).join('\n'), /宠物资料4/);
    assert.doesNotMatch(sent.map(s => s.body).join('\n'), /临时事件/);
    await service.notifyPending();
    assert.equal(sent.length, 3);
    const restart = new MemoryService({ directory: root, getProfile: () => profile, logger: quiet, now, complete: async () => message({ memories: [] }) });
    t.after(() => restart.dispose());
    restart.registerBot({ uin: 12345, pickUser: () => ({ sendMsg: async body => { sent.push({ body }); return true; } }) });
    await restart.notifyPending(); assert.equal(sent.length, 3);
    advance(6 * 3600000);
    await restart.notifyPending(); assert.equal(sent.length, 6);
});

test('私聊分页中途失败时从失败页恢复，不重复发送已成功页', async t => {
    const { service, store, advance } = setup(t);
    store.setConfig({ reminderPageSize: 1, reminderInitialDelaySeconds: 0 });
    seedReview(service, [pet(), pet({ content: '另一条宠物资料' })], [source()]);
    const sent = []; let fail = true;
    service.registerBot({ uin: 1, pickUser: () => ({ sendMsg: async body => { if (body.includes('另一条') && fail) throw Error('offline'); sent.push(body); return true; } }) });
    await service.notifyPending();
    assert.equal(sent.length, 1);
    assert.equal(store.data.reminders['22222'].lastSentAt, undefined);
    fail = false;
    await service.notifyPending(); assert.equal(sent.length, 1);
    advance(300001); await service.notifyPending();
    assert.equal(sent.length, 2);
    assert.match(sent[1], /另一条/);
});



test('插件上下文长度0连续聊天不携带旧消息且不存历史', async t => {
    const h = pluginHarness(t, { config: { 'deepseekJS:maxLength': '0' } });
    await h.instance.chat(h.event()); await h.instance.chat(h.event()); await h.instance.chat(h.event());
    assert.deepEqual(h.calls.map(c => c.messages.length), [2, 2, 2]);
    assert.equal(h.api.memory.store.history('12345:group:99999', 3).length, 0);
});

test('旧版开关保持开启也不恢复监听，不读取旧Redis开关或注册判断定时器', async t => {
    const keys = ['deepseekJS:companion:99999', 'deepseekJS:companion:12345:group:99999'];
    const h = pluginHarness(t, { config: Object.fromEntries(keys.map(key => [key, '1'])), startup: keys });
    await turn();
    for (const content of ['普通群聊内容', '呱瓜你刚才说什么', '#陪伴', '#陪伴 开启', '#呱瓜陪伴 关闭', '#呱瓜 开启陪伴']) {
        assert.equal(await h.dispatch(h.event(content)), null);
    }
    assert.equal(h.calls.length, 0);
    assert.equal(h.api.memory.store.data.observations.length, 0);
    assert.equal(h.redisAccess.some(key => key.includes('companion')), false);
    assert.deepEqual(h.intervals, []);
    assert.equal(typeof h.instance.companionMonitor, 'undefined');
    assert.equal(typeof h.instance.companionCommand, 'undefined');
    assert.equal(typeof h.instance.companionDecide, 'undefined');
});

test('引用生成中的有效补充合并重判，无关成员群聊不会入模', async t => {
    const d = deferred(), began = deferred();
    const clock = new FakeClock();
    const h = quotedHarness(t, { listeningClock: clock, judgment: params => message({ action: 'reply',
        message_ids: JSON.parse(params.messages[1].content).messages.map(item => item.id) }), response: async (_, count) => {
        if (count === 1) return message('初次回答');
        if (count === 2) { began.resolve(); return d.promise; }
        return message('第二条追问的回答');
    } });
    await h.instance.chat(h.event());
    const e = h.follow('第一条追问');
    await h.instance.accept(e); await began.promise;
    await h.instance.accept(h.event('群友之间的无关消息', { user_id: 44444 }));
    await h.instance.accept(h.follow('第二条追问', e.reply_id));
    const pending = h.api.memory.chains.get(sessionKey(e));
    d.resolve(message('第一条追问的回答')); await pending;
    assert.equal(h.calls.length, 2);
    await clock.advance(8000);
    assert.equal(h.calls.length, 3);
    assert.match(JSON.stringify(h.calls[2].messages), /第一条追问/);
    assert.match(JSON.stringify(h.calls[2].messages), /第二条追问/);
    assert.doesNotMatch(JSON.stringify(h.calls[2].messages), /第一条追问的回答/);
    assert.doesNotMatch(JSON.stringify(h.calls), /群友之间的无关消息/);
});

test('自定义提示词也保留记忆状态规则；待确认宠物资料进入普通对话', async t => {
    const h = pluginHarness(t, { config: { 'deepseekJS:prompt': '自定义人设' } });
    h.api.memory.ingest([pet()], [source()]);
    await h.instance.chat(h.event('#呱瓜 豆包怎么样'));
    assert.match(h.calls[0].messages[0].content, /自定义人设/);
    assert.match(h.calls[0].messages[0].content, /待确认参考/);
    assert.match(h.calls[0].messages[0].content, /豆包/);
});

test('同会话模型请求串行，新明确问题取消旧回复，重置阻止迟到写回', async t => {
    const d = deferred(), began = deferred();
    const h = pluginHarness(t, { response: (_, count) => { if (count === 1) { began.resolve(); return d.promise; } return message('第二轮'); } });
    const first = h.instance.chat(h.event('#呱瓜 第一轮')); await began.promise;
    const second = h.instance.chat(h.event('#呱瓜 第二轮')); await turn();
    assert.equal(h.calls.length, 1);
    d.resolve(message('第一轮回复')); await Promise.all([first, second]);
    assert.doesNotMatch(JSON.stringify(h.calls[1].messages), /第一轮回复/);
    assert.doesNotMatch(JSON.stringify(h.replies), /第一轮回复/);
    assert.match(JSON.stringify(h.replies), /第二轮/);
    const delayed = deferred(), started = deferred();
    const x = pluginHarness(t, { response: () => { started.resolve(); return delayed.promise; } });
    const e = x.event(); const running = x.instance.chat(e); await started.promise;
    await x.instance.reset(e); delayed.resolve(message('旧回复')); await running;
    assert.equal(x.api.memory.store.history(sessionKey(e), 3).length, 0);
    assert.ok(!x.replies.some(r => Array.isArray(r) && r.includes('旧回复')));
});

test('资料加载损坏后添加操作拒绝覆盖；生日0天边界和超长历史截断', async t => {
    const h = pluginHarness(t);
    fs.writeFileSync(path.join(h.root, 'member-profile.json'), '{broken');
    h.api.reloadProfile();
    await h.instance.profileCmd(h.event('#呱瓜资料添加 新人 44444'));
    assert.equal(fs.readFileSync(path.join(h.root, 'member-profile.json'), 'utf8'), '{broken');
    assert.match(h.api.executeProfileQuery('upcoming_birthdays', '', 0), /未来0天/);
    const formatted = h.instance.formatGroupChatHistory([{ sender: { nickname: '群员', user_id: 1 }, raw_message: 'x'.repeat(100000) }]);
    assert.ok(formatted[0].length < 600);
});

test('记忆确认、修正、删除管理命令可直接处理私聊提醒中的编号', async t => {
    const h = pluginHarness(t);
    h.api.memory.ingest([pet()], [source()]);
    const id = h.api.memory.store.pending()[0].id;
    const e = h.event(`#memory 确认 ${id}`);
    await h.instance.memoryCmd(e);
    assert.equal(h.api.memory.store.data.records[0].status, 'confirmed');
    e.msg = `#memory 修正 ${id} 豆包是一只白猫`; await h.instance.memoryCmd(e);
    assert.equal(h.api.memory.store.data.records[0].content, '豆包是一只白猫');
    e.msg = `#memory 删除 ${id}`; await h.instance.memoryCmd(e);
    assert.equal(h.api.memory.store.data.records[0].status, 'deleted');
});

test('通过当前群另一位成员名字召回跨群宠物，关联事实即使没写主人名字也能找到', t => {
    const { service, store } = setup(t);
    store.change(data => { data.people['33333'] = { name: '阿明', namesByGroup: { another: { name: '本群阿明' } } }; });
    service.ingest([pet()], [source()]);
    const context = recall(service, { userIds: ['44444'], groupId: 'another', query: '阿明的猫叫什么来着' }, ['33333', '44444']);
    assert.match(context, /豆包/);
    assert.match(context, /待确认参考/);
});

test('手动修正宠物记忆不保留旧特征，旧版本可以追溯', t => {
    const { service, store } = setup(t);
    service.ingest([pet()], [source()]);
    const id = store.data.records[0].id;
    store.manage('修正', id, '豆包是一只白猫', '22222');
    assert.equal(store.data.records[0].entity, undefined);
    assert.equal(store.data.records[0].revisions[0].entity.attributes, '橘猫');
    assert.equal(store.data.records[0].status, 'confirmed');
});

test('资料暂时不可读时不提前标记迁移完成，修复后仍能迁移旧记忆', async t => {
    const root = directory(t); let broken = true;
    const service = new MemoryService({ directory: root, getProfile: () => {
        if (broken) throw Error('broken profile');
        return { users: { '33333': { name: '阿明', learned: [{ alias: '明明' }] } }, pending: [] };
    }, logger: quiet, complete: async () => message({ memories: [] }) });
    t.after(() => service.dispose());
    assert.equal(service.store.data.migratedProfile, false);
    broken = false; await service.tick();
    assert.equal(service.store.data.migratedProfile, true);
    assert.equal(service.store.data.records[0].content, '明明');
});

function addOrphans(store, count = 3) {
    store.change(data => {
        for (let n = 0; n < count; n++) store.addTo(data, { type: 'alias', content: `旧称呼${n + 1}`, subjectId: '', status: 'pending', source: { at: '2026-09-11', quote: '', context: 'AI学习' } });
    });
}

test('旧称呼缺少成员及上下文时明确标注，新的第三方信息分别展示对象和说话人', t => {
    const { service, store } = setup(t);
    addOrphans(store);
    const pages = service.pages(store.pending(), '待确认').join('\n');
    assert.match(pages, /旧称呼待归属/);
    assert.match(pages, /对应成员、原话和群范围均未保存/);
    assert.doesNotMatch(pages, /跨群个人信息|对象未确定/);
    store.change(data => { data.people['33333'] = { name: '阿明' }; data.people['44444'] = { name: '阿红' }; });
    present(service, '99999', ['33333', '44444']);
    service.ingest([pet({ userid: '44444', evidence: '阿红养了一只橘猫，名字叫豆包' })], [source('阿红养了一只橘猫，名字叫豆包')]);
    const view = service.display(store.pending().at(-1));
    assert.match(view, /阿红（44444）/);
    assert.match(view, /说话人：阿明（33333）/);
    assert.match(view, /原话：阿红养了一只橘猫/);
    service.ingest([pet({ userid: '', content: '有一只橘猫叫豆包', evidence: '有人养了一只橘猫，名字叫豆包' })], [source('有人养了一只橘猫，名字叫豆包')]);
    assert.match(service.display(store.pending().at(-1)), /对应成员待识别/);
    assert.doesNotMatch(service.display(store.pending().at(-1)), /旧.*待归属/);
});

test('稳定M编号可用列表和范围批量处理，缩写M6也能识别且同步清理旧learned', async t => {
    const h = pluginHarness(t, { p: { ...profile, users: { ...profile.users, '33333': { name: '阿明', learned: [{ alias: '明明' }] } } } });
    addOrphans(h.api.memory.store, 4);
    await h.instance.memoryCmd(h.event('#memory 确认 M2-M3 阿明'));
    assert.ok(h.api.memory.store.data.records.slice(1, 3).every(r => r.subjectId === '33333' && r.status === 'confirmed'));
    await h.instance.memoryCmd(h.event('#memory 忽略 M1,M4-M5'));
    assert.ok([0, 3, 4].every(n => h.api.memory.store.data.records[n].status === 'ignored'));
    assert.equal(h.api.loadProfile().users['33333'].learned.length, 0);
});

test('私聊列表跨页连续编号，一条回复可把多组称呼归给不同成员并批量忽略', async t => {
    const h = pluginHarness(t);
    const store = h.api.memory.store;
    store.setConfig({ reminderPageSize: 2 });
    store.change(data => { data.people['33333'] = { name: '阿明' }; data.people['44444'] = { name: '阿红' }; });
    addOrphans(store, 6);
    const e = h.event('#memory 待确认', { group_id: undefined, user_id: 22222 });
    await h.instance.memoryCmd(e);
    assert.equal(h.replies.length, 3);
    assert.match(h.replies[1], /3\. M000003/);
    const reply = h.event('#memory 1-2 是 阿明；3,4 是 阿红\n忽略 5-6', { group_id: undefined, user_id: 22222 });
    assert.equal(await h.instance.accept(reply), false);
    assert.ok(store.data.records.every(r => r.status === 'pending'));
    assert.equal(await h.dispatch(reply), 'memoryCmd');
    assert.ok(store.data.records.slice(0, 2).every(r => r.subjectId === '33333' && r.status === 'confirmed'));
    assert.ok(store.data.records.slice(2, 4).every(r => r.subjectId === '44444' && r.status === 'confirmed'));
    assert.ok(store.data.records.slice(4).every(r => r.status === 'ignored'));
    assert.match(h.replies.at(-1), /已确认 4 条，已忽略 2 条/);
    assert.equal(h.calls.length, 0);
});

test('确认全部只确认当前已展示列表中对象明确的记录，新增未展示记录不受影响', async t => {
    const h = pluginHarness(t), memory = h.api.memory;
    seedReview(memory, [pet(), pet({ content: '另一条宠物资料' })], [source()]);
    addOrphans(memory.store, 2);
    const e = h.event('#memory 待确认', { group_id: undefined, user_id: 22222 });
    await h.instance.memoryCmd(e);
    seedReview(memory, [pet({ content: '列表发送后新增的记忆' })], [source()]);
    await h.dispatch(h.event('#memory 确认全部', { group_id: undefined, user_id: 22222 }));
    assert.deepEqual(memory.store.data.records.map(r => r.status), ['confirmed', 'confirmed', 'pending', 'pending', 'pending']);
    assert.match(h.replies.at(-1), /跳过 2 条/);
    await h.dispatch(h.event('#memory 忽略旧记录', { group_id: undefined, user_id: 22222 }));
    assert.equal(memory.store.pending().length, 1);
    assert.equal(memory.store.pending()[0].content, '列表发送后新增的记忆');
});

test('批量输入有不存在的编号、缺少成员或重名时整批回滚，不确认一半', async t => {
    const h = pluginHarness(t), store = h.api.memory.store;
    addOrphans(store, 3);
    store.change(data => { data.people['33333'] = { name: '重名' }; data.people['44444'] = { name: '重名' }; });
    for (const command of ['#memory 确认 M1,M99 33333', '#memory 确认 M1-M3', '#memory 确认 M1-M3 重名', '#memory 确认 M1-M2 33333；忽略 M2']) {
        await h.instance.memoryCmd(h.event(command));
        assert.ok(store.data.records.every(r => r.status === 'pending' && !r.subjectId));
        assert.match(h.replies.at(-1), /未完成/);
    }
});

test('主动提醒可带前缀快捷回复，引用旧提醒按旧序号处理，快照与发送凭据重启后仍保留', async t => {
    const { service, store, root, now } = setup(t);
    store.setConfig({ reminderInitialDelaySeconds: 0 });
    addOrphans(store, 2);
    const sent = [];
    service.registerBot({ uin: 12345, pickUser: () => ({ sendMsg: async body => { sent.push(body); return { message_id: 'reminder-1', seq: 11, time: 100 }; } }) });
    await service.notifyPending();
    const reply = { self_id: 12345, user_id: 22222, msg: '#memory 1 是 33333', isMaster: true, source: { user_id: 12345, seq: 11, time: 100 } };
    assert.ok(service.reviewFor(reply));
    const restart = new MemoryService({ directory: root, getProfile: () => profile, logger: quiet, now, complete: async () => message({ memories: [] }) });
    t.after(() => restart.dispose());
    assert.ok(restart.reviewFor(reply));
    const reviewEvent = { ...reply, source: undefined, reply: async () => ({ message_id: 'new-list' }) };
    await restart.sendReview(reviewEvent, [...restart.store.pending()].reverse(), '新列表');
    assert.equal(restart.planReview(reply, reply.msg, { replyOnly: true }).operations[0].id, 'M000001');
    assert.equal(restart.planReview({ ...reply, source: undefined }, reply.msg, { replyOnly: true }).operations[0].id, 'M000002');
    assert.equal(restart.reviewFor({ ...reply, source: undefined, reply_id: 'reminder-1' }, true).ids[0], 'M000001');
    assert.equal(sent.length, 1);
});

test('记忆管理不接管无前缀消息，独立命令遵守主人权限及列表引用范围', async t => {
    const h = pluginHarness(t);
    addOrphans(h.api.memory.store);
    await h.instance.memoryCmd(h.event('#memory 待确认', { group_id: undefined, user_id: 22222 }));
    for (const e of [
        h.event('确认今天吃什么了吗', { group_id: undefined, user_id: 22222 }),
        h.event('忽略天气的话题吧', { group_id: undefined, user_id: 22222 }),
        h.event('#其他插件命令', { group_id: undefined, user_id: 22222 })
    ]) {
        assert.equal(await h.dispatch(e), null);
    }
    assert.equal(await h.dispatch(h.event('#memory 确认全部', { group_id: undefined, user_id: 33333, isMaster: false })), 'denied');
    await h.dispatch(h.event('#memory 1 是 33333', { group_id: 99999, user_id: 22222 }));
    assert.match(h.replies.at(-1), /先查看待确认列表/);
    await h.dispatch(h.event('#memory 1 是 33333', { group_id: undefined, user_id: 22222, source: { message_id: 'unrelated-message' } }));
    assert.match(h.replies.at(-1), /先查看待确认列表/);
    assert.ok(h.api.memory.store.pending().length === 3);
});

test('部分页面发送失败时只能处理已展示内容，恢复重试后未展示页才可操作', async t => {
    const { service, store, advance } = setup(t);
    addOrphans(store, 3);
    store.setConfig({ reminderInitialDelaySeconds: 0, reminderPageSize: 1 });
    let sent = 0, fail = true;
    service.registerBot({ uin: 12345, pickUser: () => ({ sendMsg: async () => { if (sent === 1 && fail) throw Error('offline'); sent++; return { message_id: `sent-${sent}` }; } }) });
    await service.notifyPending();
    const e = { self_id: 12345, user_id: 22222, isMaster: true, msg: '#memory 忽略全部' };
    assert.equal(service.planReview(e, e.msg, { replyOnly: true }).operations.length, 1);
    assert.throws(() => service.planReview(e, '忽略 2', { replyOnly: true }), /尚未成功展示/);
    fail = false; advance(300001); await service.notifyPending();
    assert.equal(service.planReview(e, e.msg, { replyOnly: true }).operations.length, 3);
    assert.equal(sent, 3);
});

test('改动过的记录不能按旧列表确认，无需引用的短回复24小时后失效', async t => {
    const { service, store, advance } = setup(t);
    addOrphans(store, 2);
    const e = { self_id: 12345, user_id: 22222, isMaster: true, msg: '#memory 1 是 33333', reply: async () => true };
    await service.sendReview(e, store.pending(), '列表');
    store.change(data => { data.records[0].content = '修改后的称呼'; });
    assert.throws(() => service.planReview(e, e.msg, { replyOnly: true }), /已变化/);
    advance(86400001);
    assert.equal(service.reviewFor(e), null);
});

test('@成员可用于批量指定对象，忽略旧记录不会删除新的有来源记忆', async t => {
    const h = pluginHarness(t);
    addOrphans(h.api.memory.store, 2);
    h.api.memory.ingest([pet()], [source()]);
    const e = h.event('#memory 确认 M1-M2 @某人', { message: [{ type: 'text', text: '#memory 确认 M1-M2 ' }, { type: 'at', qq: 33333 }] });
    await h.instance.memoryCmd(e);
    assert.ok(h.api.memory.store.data.records.slice(0, 2).every(r => r.status === 'confirmed' && r.subjectId === '33333'));
    addOrphans(h.api.memory.store, 1);
    await h.instance.memoryCmd(h.event('#memory 忽略旧记录'));
    assert.equal(h.api.memory.store.pending().length, 1);
    assert.equal(h.api.memory.store.pending()[0].entity.name, '豆包');
});

test('框架将发送失败包装成error结果时不误记为已展示，也不会允许短回复处理未收到列表', async t => {
    const { service, store } = setup(t);
    addOrphans(store, 2);
    const e = { self_id: 12345, user_id: 22222, isMaster: true, msg: '#memory 忽略全部', reply: async () => ({ error: ['offline'] }) };
    await assert.rejects(service.sendReview(e, store.pending(), '列表'), /发送未成功/);
    assert.equal(service.reviewFor(e), null);
    store.setConfig({ reminderInitialDelaySeconds: 0 });
    service.registerBot({ uin: 12345, pickUser: () => ({ sendMsg: e.reply }) });
    await service.notifyPending();
    assert.ok(store.data.reminders['22222'].retryAt > service.now());
    assert.equal(store.data.reminders['22222'].lastSentAt, undefined);
    assert.equal(service.reviewFor(e), null);
});

test('列表短序号限定在同一主人、机器人及对话，昵称中带“是”也可正确归属', async t => {
    const h = pluginHarness(t), memory = h.api.memory;
    addOrphans(memory.store, 2);
    memory.store.change(data => { data.people['33333'] = { name: '我是阿明' }; });
    const e = h.event('#memory 待确认', { group_id: undefined, user_id: 22222 });
    await h.instance.memoryCmd(e);
    for (const overrides of [{ self_id: 54321 }, { user_id: 44444 }, { group_id: 88888 }]) {
        assert.throws(() => memory.planReview({ ...e, ...overrides }, '确认 1 我是阿明'), /先查看待确认列表/);
    }
    await h.instance.memoryCmd(h.event('#memory 确认 1-2 我是阿明', { group_id: undefined, user_id: 22222 }));
    assert.ok(memory.store.data.records.every(r => r.status === 'confirmed' && r.subjectId === '33333'));
});

test('#memory和#呱瓜通过独立规则分发，聊天入口不再处理记忆管理', async t => {
    const h = pluginHarness(t), memory = h.api.memory;
    memory.ingest([pet()], [source()]);
    const privateEvent = content => h.event(content, { group_id: undefined, user_id: 22222 });
    assert.equal(await h.dispatch(privateEvent('#memory')), 'memoryCmd');
    assert.match(h.replies.at(-1), /待确认记忆/);
    const replyCount = h.replies.length;
    for (const content of ['确认全部', '忽略全部', '1 是 33333', '忽略旧记录']) {
        const e = privateEvent(content);
        assert.equal(await h.dispatch(e), null);
    }
    assert.equal(memory.store.pending().length, 1);
    assert.equal(h.replies.length, replyCount);
    for (const content of ['#呱瓜确认全部', '#呱瓜 1 是 33333', '#呱瓜记忆确认全部', '#呱瓜 今天吃什么好呢']) {
        assert.equal(await h.dispatch(privateEvent(content)), 'chat');
        assert.equal(memory.store.pending().length, 1);
    }
    const callsBeforeCommand = h.calls.length;
    const command = privateEvent('#memory 确认全部');
    assert.equal(await h.instance.accept(command), false);
    assert.equal(memory.store.pending().length, 1);
    assert.equal(await h.dispatch(command), 'memoryCmd');
    assert.equal(memory.store.pending().length, 0);
    assert.equal(h.calls.length, callsBeforeCommand);
});

test('#memory要求独立单词边界，未知操作留在管理入口，群聊也能批量处理', async t => {
    const h = pluginHarness(t), memory = h.api.memory;
    addOrphans(memory.store, 2);
    for (const content of ['#memoryx 确认全部', '#memory确认全部', '#memory123', '#mymemory 确认全部']) {
        assert.equal(await h.dispatch(h.event(content)), null);
        assert.equal(await h.instance.memoryCmd(h.event(content)), false);
    }
    assert.equal(await h.dispatch(h.event('#memory 不存在的操作')), 'memoryCmd');
    assert.match(h.replies.at(-1), /记忆管理：#memory/);
    await h.dispatch(h.event('#memory 待确认'));
    assert.equal(await h.dispatch(h.event('#memory 1-2 是 33333')), 'memoryCmd');
    assert.ok(memory.store.data.records.every(r => r.subjectId === '33333' && r.status === 'confirmed'));
    assert.equal(h.calls.length, 0);
});

test('图片summary带方括号、引号或CQ转义时完整替换，不残留file等参数', t => {
    const h = pluginHarness(t);
    const cases = [
        ['[CQ:image,summary=[微笑],file=x]', '[表情包:微笑]'],
        ['[CQ:image,summary="[微笑]",file=x]', '[表情包:微笑]'],
        ['[CQ:image,file=x,summary=[动画表情],sub_type=1]', '[表情包:动画表情]'],
        ['[CQ:image,summary=&#91;微笑&#93;,file=x]', '[表情包:微笑]'],
        ['[CQ:image,summary=[微笑][眨眼],file=x]', '[表情包:微笑眨眼]'],
        ['[CQ:image,file=x,sub_type=1]', '[动画表情]'],
        ['[CQ:image,file=x]', '[图片]'],
        ['[CQ:image]', '[图片]']
    ];
    for (const [raw, expected] of cases) {
        const result = h.api.processCQCode(raw);
        assert.equal(result.content, expected, raw);
        assert.equal(result.isPureCQ, true, raw);
    }
    const serialized = h.api.getRawMessageFromArray([{ type: 'image', summary: '[微笑]', file: 'x' }]);
    assert.equal(h.api.processCQCode(serialized).content, '[表情包:微笑]');
});

test('带方括号summary的图片不会吞掉相邻文字、@、分享卡片或下一张图片', t => {
    const h = pluginHarness(t);
    const raw = '前文[CQ:image,summary=[微笑],file=x]中间[CQ:at,qq=33333,name=阿明][CQ:share,url=https://example.com,title=卡片][CQ:image,summary=[动画表情],file=y]后文';
    const result = h.api.processCQCode(raw);
    assert.equal(result.content, '前文[表情包:微笑]中间[提及阿明][未知消息][表情包:动画表情]后文');
    assert.equal(result.isPureCQ, false);
});

test('引用消息和群历史复用完整图片边界，summary在file前也可提取图片且遵守数量限制', async t => {
    const h = pluginHarness(t);
    const raw = '[CQ:image,summary="[微笑]",file=cache-x,url=https://example.com/a?x=1&amp;y=2]文字[CQ:at,qq=33333][CQ:image,summary=[动画表情],file=https://example.com/b]';
    const e = h.event('引用', { reply_id: 'quoted-1', getReply: async () => ({ raw_message: raw }) });
    const quoted = await h.api.getQuotedMessage(e, 2);
    assert.deepEqual([...quoted.images], ['https://example.com/a?x=1&y=2', 'https://example.com/b']);
    assert.equal(quoted.text, '[表情包:微笑]文字[提及用户33333][表情包:动画表情]');
    assert.equal((await h.api.getQuotedMessage(e, 1)).images.length, 1);
    const history = h.instance.formatGroupChatHistory([{ raw_message: raw }])[0];
    assert.match(history, /\[图片\]文字\[@用户33333\]\[图片\]/);
    assert.doesNotMatch(history, /summary=|file=|cache-x|https:\/\//);
});

function scopedProfile() {
    return { version: 1, users: {
        '22222': { name: '主人', role: 'master' },
        '33333': { name: '阿明', birthday: '1月1日', aliases: ['明明'], groups: { '11111': {}, '22222': {} } },
        '44444': { name: '甲群成员', birthday: '1月2日', aliases: ['同名'], groups: { '11111': {} } },
        '55555': { name: '乙群成员', birthday: '2月2日', aliases: ['同名'], groups: { '22222': {} } },
        '88888': { name: '沉默成员', birthday: '3月3日', groups: { '22222': { note: '乙群专用备注' } } }
    }, pending: [] };
}

test('同一人在两群共用稳定宠物信息，事件约定临时偏好和自动称呼留在原群', t => {
    const { service, store } = setup(t);
    const s = source('我养了一只橘猫，名字叫豆包；明晚甲群开黑；周末甲群复习；这周只喝茶；本群叫我夜猫', { groupId: '11111', session: '12345:group:11111' });
    service.ingest([
        pet(),
        pet({ type: 'event', content: '明晚甲群开黑', evidence: '明晚甲群开黑', scope: 'global' }),
        pet({ type: 'agreement', content: '周末甲群复习', evidence: '周末甲群复习', scope: 'global' }),
        pet({ type: 'preference', content: '这周只喝茶', evidence: '这周只喝茶', scope: 'group' }),
        pet({ type: 'alias', content: '夜猫', evidence: '本群叫我夜猫', scope: 'global' })
    ], [s]);
    assert.deepEqual(store.data.records[0].scope, { kind: 'person' });
    assert.ok(store.data.records.slice(1).every(r => r.scope.kind === 'group' && r.scope.groupId === '11111'));
    const a = recall(service, { userIds: ['33333'], groupId: '11111' });
    const b = recall(service, { userIds: ['33333'], groupId: '22222' });
    assert.match(a, /豆包/);
    assert.match(a, /明晚甲群开黑/);
    assert.match(b, /待确认参考/);
    assert.match(b, /豆包/);
    assert.doesNotMatch(b, /甲群开黑|甲群复习|只喝茶|夜猫/);
    store.manage('确认', store.data.records[0].id, '', '22222');
    assert.match(recall(service, { userIds: ['33333'], groupId: '22222' }), /已确认长期记忆/);
    assert.ok(store.data.records.filter(r => ['event', 'agreement'].includes(r.type)).every(r => r.status === 'active'));
});

test('遗漏或无效scope不会把事件、约定或临时信息变成全局记忆', t => {
    const { service, store } = setup(t);
    const s = source('今晚本群聚会；下周本群复习；最近暂时不喝咖啡');
    service.ingest([
        pet({ type: 'event', content: '今晚本群聚会', evidence: '今晚本群聚会', scope: undefined }),
        pet({ type: 'agreement', content: '下周本群复习', evidence: '下周本群复习', scope: 'invalid' }),
        pet({ type: 'preference', content: '最近暂时不喝咖啡', evidence: '最近暂时不喝咖啡', scope: undefined })
    ], [s]);
    assert.ok(store.data.records.every(r => r.scope.kind === 'group' && r.scope.groupId === '99999'));
    assert.match(recall(service, { userIds: ['33333'], groupId: '99999' }), /本群聚会/);
    assert.equal(recall(service, { userIds: ['33333'], groupId: '22222' }), '');
});

test('私聊事件和称呼只在原私聊使用，稳定宠物信息仍可跟随本人到群聊', t => {
    const { service, store } = setup(t);
    const s = source('我养了一只橘猫，名字叫豆包；明晚一起复习；这里叫我夜猫', { groupId: '', session: '12345:private:33333' });
    service.ingest([pet(), pet({ type: 'event', content: '明晚一起复习', evidence: '明晚一起复习' }),
        pet({ type: 'alias', content: '夜猫', evidence: '这里叫我夜猫' })], [s]);
    store.manage('确认', store.data.records[2].id, '', '22222');
    assert.match(recall(service, { userIds: ['33333'], sessionId: s.session }), /明晚一起复习/);
    assert.deepEqual(store.aliases('33333', '', s.session), ['夜猫']);
    assert.deepEqual(store.aliases('33333', '11111'), []);
    const group = recall(service, { userIds: ['33333'], groupId: '11111' });
    assert.match(group, /豆包/);
    assert.doesNotMatch(group, /复习|夜猫/);
    assert.doesNotMatch(recall(service, { userIds: ['33333'], sessionId: '12345:private:44444' }), /复习|夜猫/);
});

test('仅宠物名或相似关键词不会召回外群无关成员；同一本人出现后可召回稳定信息', t => {
    const { service, store } = setup(t);
    store.change(data => { data.people['33333'] = { name: '阿明', namesByGroup: { '11111': { name: '本群阿明' } } }; });
    service.ingest([pet()], [source()]);
    assert.equal(recall(service, { userIds: ['44444'], groupId: '22222', query: '阿明的猫豆包' }), '');
    assert.match(recall(service, { userIds: ['44444'], groupId: '11111', query: '阿明的猫叫什么' }, ['33333', '44444']), /豆包/);
    assert.match(recall(service, { userIds: ['33333'], groupId: '22222', query: '我的猫' }), /豆包/);
});

test('跨群同名按本群身份查询，不回退外群；QQ号、生日、失败名单和群内导出统一使用成员范围', t => {
    const h = pluginHarness(t, { p: scopedProfile() });
    const ctx = { '11111': present(h.api.memory, '11111', ['33333', '44444']), '22222': present(h.api.memory, '22222', ['33333', '55555']) };
    const query = (a, target, days, gid, master) => h.api.executeProfileQuery(a, target, days, gid, master, ctx[gid]);
    const findByAlias = (name, gid) => h.api.findByAlias(name, gid, ctx[gid]);
    assert.equal(findByAlias('同名', '11111').userid, '44444');
    assert.equal(findByAlias('同名', '22222').userid, '55555');
    assert.equal(findByAlias('同名', '99999'), null);
    assert.doesNotMatch(query('user_info', '乙群成员', 7, '11111', false), /生日:2月2日|userid=55555/);
    assert.doesNotMatch(query('user_info', '55555', 7, '11111', false), /生日:2月2日|userid=55555/);
    const birthdays = query('upcoming_birthdays', '', 365, '11111', false);
    assert.match(birthdays, /阿明|甲群成员/);
    assert.doesNotMatch(birthdays, /乙群成员|沉默成员/);
    const notFound = query('user_info', '不存在的人', 7, '11111', false);
    assert.match(notFound, /本群已收录用户/);
    assert.doesNotMatch(notFound, /乙群成员|沉默成员/);
    assert.doesNotMatch(query('full_export', '', 7, '11111', true), /乙群成员|沉默成员/);
    assert.match(query('full_export', '', 7, undefined, true), /乙群成员/);
    assert.match(query('full_export', '', 7, '11111', false), /仅限主人/);
    assert.match(query('user_info', '阿明', 7, '22222', false), /生日:1月1日/);
});

test('框架当前成员表能识别跨群的沉默成员，也不沿用已不在群内的人工归属', async t => {
    const h = pluginHarness(t, { p: scopedProfile() });
    const e = h.event('#呱瓜 查资料', { group_id: 11111 });
    e.bot.gml = new Map([['11111', new Map([[33333, {}], [88888, {}]])]]);
    const context = await h.api.profileQueryContext(e);
    assert.deepEqual(h.api.memory.memberIds('11111', context), ['33333', '88888']);
    const result = h.api.executeProfileQuery('user_info', '沉默成员', 7, '11111', false, context);
    assert.match(result, /userid=88888|生日:3月3日/);
    assert.doesNotMatch(result, /乙群专用备注/);
    const birthdays = h.api.executeProfileQuery('upcoming_birthdays', '', 365, '11111', false, context);
    assert.match(birthdays, /沉默成员/);
    assert.doesNotMatch(birthdays, /甲群成员|乙群成员/);
});

test('工具查询核实成员表；失败后不会使用人工或旧发言归属', async t => {
    const h = pluginHarness(t, { p: scopedProfile() });
    const e = h.event('', { group_id: 11111 });
    let reads = 0;
    e.bot.gml = new Map([[11111, new Map()]]);
    e.group.getMemberMap = async () => { reads++; return new Map([[33333, {}], [88888, {}]]); };
    e.bot.pickGroup = () => ({});
    const context = await h.api.profileQueryContext(e, [], true);
    assert.equal(reads, 1);
    assert.match(h.api.executeProfileQuery('user_info', '88888', 7, '11111', false, context), /生日:3月3日/);
    e.group.getMemberMap = async () => { throw Error('adapter unavailable'); };
    h.api.memory.roster.fresh.clear(); h.api.memory.roster.attempts.clear();
    const fallback = await h.api.profileQueryContext(e, [], true);
    assert.doesNotMatch(h.api.executeProfileQuery('user_info', '甲群成员', 7, '11111', false, fallback), /userid=44444/);
});

test('两群名片分别保存和识别，QQ昵称保持全局，重启后仍不会用外群名片认人', t => {
    const { service, store, root } = setup(t);
    for (const [gid, card] of [['11111', '甲群夜猫'], ['22222', '乙群早鸟']]) {
        service.observe({ self_id: 12345, user_id: 33333, group_id: gid, message_id: gid,
            sender: { nickname: '稳定QQ昵称', card }, message: [] }, '普通发言');
    }
    assert.equal(store.data.people['33333'].name, '稳定QQ昵称');
    assert.equal(service.memberName('33333', '11111'), '甲群夜猫');
    assert.equal(service.memberName('33333', '22222'), '乙群早鸟');
    assert.ok(service.names('33333', '11111').includes('稳定QQ昵称'));
    assert.ok(!service.names('33333', '11111').includes('乙群早鸟'));
    const reopened = new MemoryService({ directory: root, getProfile: () => profile, logger: quiet, complete: async () => message({ memories: [] }) });
    t.after(() => reopened.dispose());
    assert.equal(reopened.memberName('33333', '11111'), '甲群夜猫');
    assert.ok(!reopened.names('33333', '11111').includes('乙群早鸟'));
});

test('旧版误存为全局的群事件和私聊约定恢复原会话，来源缺失的事件不外推，稳定信息保持共用', t => {
    const { store, root } = setup(t);
    store.change(data => {
        const base = { subjectId: '33333', status: 'active', expiresAt: '2026-12-01T00:00:00Z' };
        store.addTo(data, { ...base, type: 'event', content: '甲群旧活动', source: { groupId: '11111', speakerId: '33333' } });
        store.addTo(data, { ...base, type: 'agreement', content: '私聊旧约定', source: { messageId: '12345:private:33333:old-message' } });
        store.addTo(data, { ...base, type: 'event', content: '来源缺失事件', source: {} });
        store.addTo(data, { type: 'entity', subjectId: '33333', content: '宠物豆包', status: 'confirmed', source: { groupId: '11111' } });
    });
    const old = JSON.parse(fs.readFileSync(store.file, 'utf8'));
    old.version = 2; old.members = old.people; delete old.people;
    for (const record of old.records) { delete record.scope; record.groupId = ''; }
    delete old.records[1].sessionId;
    old.members['33333'] = { name: '不明所属群的旧名片', lastSeenAt: '2026-10-15' };
    fs.writeFileSync(store.file, JSON.stringify(old));
    const service = new MemoryService({ directory: root, getProfile: () => profile, now: store.now, logger: quiet, complete: async () => message({ memories: [] }) });
    t.after(() => service.dispose());
    assert.equal(service.store.data.records.length, 4);
    assert.equal(service.store.data.records[0].scope.groupId, '11111');
    assert.equal(service.store.data.records[1].scope.sessionId, '12345:private:33333');
    assert.deepEqual(service.store.data.records[3].scope, { kind: 'person' });
    assert.equal(service.memberName('33333', '22222'), '33333');
    assert.match(recall(service, { userIds: ['33333'], groupId: '11111' }), /甲群旧活动/);
    assert.match(recall(service, { userIds: ['33333'], sessionId: '12345:private:33333' }), /私聊旧约定/);
    const other = recall(service, { userIds: ['33333'], groupId: '22222' });
    assert.match(other, /宠物豆包/);
    assert.doesNotMatch(other, /旧活动|旧约定|来源缺失事件/);
    assert.match(service.display(service.store.data.records[2]), /暂停自动召回/);
});

test('按人查询只返回该人的记忆，不因名字相同的关键词带入另一成员的记录', t => {
    const h = pluginHarness(t, { p: scopedProfile() });
    h.api.memory.ingest([pet()], [source()]);
    h.api.memory.ingest([pet({ type: 'fact', userid: '44444', content: '阿明的同款宠物属于甲群成员', evidence: '阿明的同款宠物属于甲群成员' })],
        [source('阿明的同款宠物属于甲群成员', { speakerId: '44444', groupId: '11111' })]);
    const result = h.api.executeProfileQuery('user_info', '阿明', 7, '11111', false, present(h.api.memory, '11111', ['33333', '44444']));
    assert.match(result, /豆包/);
    assert.doesNotMatch(result, /同款宠物/);
});

test('普通聊天工具查询识别当前成员并使用他的跨群稳定信息，不引入另一群的安排', async t => {
    const h = pluginHarness(t, { p: scopedProfile(), response: (_, count) => count === 1 ? { choices: [{ finish_reason: 'tool_calls', message: {
        role: 'assistant', content: null, tool_calls: [{ id: 'profile-tool', type: 'function', function: {
            name: 'member_profile_query', arguments: JSON.stringify({ action: 'user_info', target: '沉默成员' })
        } }]
    } }] } : message('查到啦') });
    const s = source('我养了一只橘猫，名字叫豆包；明晚乙群开黑', { speakerId: '88888', groupId: '22222' });
    h.api.memory.ingest([pet({ userid: '88888' }), pet({ userid: '88888', type: 'event', content: '明晚乙群开黑', evidence: '明晚乙群开黑' })], [s]);
    const e = h.event('#呱瓜 查一下沉默成员', { group_id: 11111 });
    e.bot.gml = new Map([[11111, new Map([[33333, {}], [88888, {}]])]]);
    await h.instance.chat(e);
    assert.equal(h.calls.length, 2);
    const result = h.calls[1].messages.find(m => m.role === 'tool').content;
    assert.match(result, /生日:3月3日/);
    assert.match(result, /豆包/);
    assert.doesNotMatch(result, /乙群开黑|乙群专用备注/);
});

test('只有自动记忆且未手工建档的成员，可以在当前群按QQ号或确认称呼查到跨群稳定资料', t => {
    const h = pluginHarness(t);
    const s = source('我养了一只橘猫，名字叫豆包；叫我夜猫', { speakerId: '77777', groupId: '11111' });
    h.api.memory.ingest([pet({ userid: '77777' }), pet({ userid: '77777', type: 'alias', content: '夜猫', evidence: '叫我夜猫' })], [s]);
    h.api.memory.store.manage('确认', h.api.memory.store.data.records[1].id, '', '22222');
    assert.equal(h.api.findByAlias('夜猫', '11111', present(h.api.memory, '11111', ['33333', '77777'])).userid, '77777');
    assert.match(h.api.executeProfileQuery('user_info', '夜猫', 7, '11111', false, present(h.api.memory, '11111', ['33333', '77777'])), /豆包/);
    const context = present(h.api.memory, '22222', ['33333', '77777'], ['33333']);
    assert.match(h.api.executeProfileQuery('user_info', '77777', 7, '22222', false, context), /豆包/);
    assert.equal(h.api.findByAlias('夜猫', '22222', context), null);
});

test('本群临时偏好确认后不覆盖个人长期偏好，也不替代其他群的同类记忆', t => {
    const { service, store } = setup(t);
    service.ingest([pet({ type: 'preference', content: '长期喜欢咖啡', evidence: '长期喜欢咖啡' })], [source('长期喜欢咖啡')]);
    const global = store.data.records[0];
    store.manage('确认', global.id, '', '22222');
    service.ingest([pet({ type: 'preference', content: '这周暂时喝茶', evidence: '这周暂时喝茶', scope: 'group', replaces: global.id })], [source('这周暂时喝茶')]);
    const local = store.data.records[1];
    store.manage('确认', local.id, '', '22222');
    assert.equal(store.data.records[0].status, 'confirmed');
    service.ingest([pet({ type: 'preference', content: '乙群只讨论茶', evidence: '乙群只讨论茶', scope: 'group', replaces: local.id })], [source('乙群只讨论茶', { groupId: '22222' })]);
    store.manage('确认', store.data.records[2].id, '', '22222');
    assert.equal(store.data.records[1].status, 'confirmed');
    const other = recall(service, { userIds: ['33333'], groupId: '33333' });
    assert.match(other, /长期喜欢咖啡/);
    assert.doesNotMatch(other, /喝茶|讨论茶/);
});

test('后台提取沿用结构化已有记忆，只包含相关本群成员的跨群稳定信息', async t => {
    let captured;
    const { service, store, advance } = setup(t, { complete: async params => {
        captured = JSON.parse(params.messages[1].content);
        assert.match(params.messages[0].content, /临时偏好.*group/);
        return message({ memories: [] });
    } });
    store.change(data => { data.people['55555'] = { name: '乙群成员', groups: { '22222': {} } }; });
    service.ingest([pet()], [source()]);
    service.ingest([pet({ userid: '55555', content: '另一个人的豆包' })], [source(undefined, { speakerId: '55555', groupId: '22222' })]);
    service.observe({ self_id: 12345, user_id: 33333, group_id: 11111, message_id: 'extract-scope', sender: { nickname: '阿明' }, message: [] }, '我的猫豆包怎么样');
    advance(31000); await service.processExtractions();
    assert.ok(Array.isArray(captured.knownMemories));
    assert.equal(captured.knownMemories.length, 1);
    assert.equal(captured.knownMemories[0].subjectId, '33333');
    assert.equal(captured.knownMemories[0].entity.name, '豆包');
});

test('成员表中的当前群名片可用于沉默成员查询，不会变成其他群的全局别名', async t => {
    const h = pluginHarness(t, { p: scopedProfile() });
    h.api.memory.ingest([pet({ userid: '88888' })], [source(undefined, { speakerId: '88888', groupId: '22222' })]);
    const e = h.event('', { group_id: 11111 });
    e.bot.gml = new Map([[11111, new Map([[33333, { nickname: '阿明' }], [88888, { card: '本群小蓝', nickname: '稳定昵称' }]])]]);
    const context = await h.api.profileQueryContext(e);
    assert.equal(h.api.findByAlias('本群小蓝', '11111', context).userid, '88888');
    assert.match(h.api.executeProfileQuery('user_info', '本群小蓝', 7, '11111', false, context), /豆包/);
    assert.match(h.api.memory.context({ ...context, query: '本群小蓝的宠物' }), /豆包/);
    assert.equal(h.api.findByAlias('本群小蓝', '22222'), null);
    assert.equal(h.api.memory.store.data.people['88888']?.namesByGroup?.['11111'], undefined);
});

test('稳定个人信息最初对象不明时仅在原群参考，主人明确归属后随本人共用', t => {
    const { service, store } = setup(t);
    service.ingest([pet({ userid: '', evidence: '有人养了一只叫豆包的橘猫' })], [source('有人养了一只叫豆包的橘猫')]);
    const record = store.data.records[0];
    assert.equal(record.scope.groupId, '99999');
    assert.match(recall(service, { groupId: '99999', query: '豆包' }), /待确认参考/);
    assert.equal(recall(service, { groupId: '22222', userIds: ['33333'], query: '豆包' }), '');
    store.manage('确认', record.id, '33333', '22222');
    assert.deepEqual(store.data.records[0].scope, { kind: 'person' });
    assert.equal(store.data.records[0].subjectId, '33333');
    assert.match(recall(service, { groupId: '22222', userIds: ['33333'], query: '豆包' }), /已确认长期记忆/);
});

function rosterEvent(getMemberMap, overrides = {}) {
    return { self_id: 12345, group_id: 11111, user_id: 33333, post_type: 'message',
        bot: { uin: 12345, pickGroup: () => ({ getMemberMap }) }, ...overrides };
}
function notice(service, uid, type = 'decrease', overrides = {}) {
    return service.notice({ self_id: 12345, group_id: 11111, user_id: uid, post_type: 'notice', notice_type: 'group', sub_type: type, ...overrides });
}

test('提及和@外群QQ不能扩大查询范围，所有资料入口使用同一成员门槛', async t => {
    const h = pluginHarness(t, { p: scopedProfile() });
    const e = h.event('#呱瓜 帮我查55555和乙群成员', { group_id: 11111,
        message: [{ type: 'at', qq: 55555 }, { type: 'text', text: '乙群成员' }] });
    e.bot.gml = new Map([[11111, new Map([[33333, {}]])]]);
    await h.instance.accept(e);
    const context = await h.api.profileQueryContext(e, ['55555', '44444']);
    assert.deepEqual(h.api.memory.memberIds('11111', context), ['33333']);
    assert.equal(h.api.findByAlias('乙群成员', '11111', context), null);
    assert.doesNotMatch(h.api.buildUserContext(['33333', '55555', '44444'], '11111', context), /55555|44444/);
    for (const [action, target] of [['user_info', '55555'], ['user_info', '乙群成员'], ['upcoming_birthdays', ''], ['full_export', '']]) {
        const result = h.api.executeProfileQuery(action, target, 365, '11111', true, context);
        assert.doesNotMatch(result.replace(`「${target}」`, ''), /乙群成员|甲群成员|userid=55555|userid=44444|生日:2月2日/);
    }
});

test('底层检索也强制成员资格，群内记录和无归属记录不能绕过；伪造名单无效', t => {
    const { service, store } = setup(t);
    service.ingest([pet({ userid: '55555' }), pet({ userid: '55555', type: 'fact', scope: 'group', content: '外群人物的豆包' })],
        [source(undefined, { speakerId: '55555', groupId: '11111' })]);
    service.ingest([pet({ userid: '', content: '有人养了一只叫豆包的橘猫', evidence: '有人养了一只叫豆包的橘猫' })],
        [source('有人养了一只叫豆包的橘猫', { speakerId: '55555', groupId: '11111' })]);
    const context = present(service, '11111', ['33333'], ['55555']);
    assert.equal(store.search({ ...context, query: '豆包', allowedUserIds: ['55555'], memberIds: ['55555'] }).length, 0);
    assert.equal(service.context({ ...context, query: '豆包', memberIds: ['55555'] }), '');
    assert.equal(store.search({ groupId: '11111', userIds: ['55555'], memberIds: ['55555'], allowedUserIds: ['55555'], query: '豆包' }).length, 0);
    assert.equal(store.search({ ...context, groupAccess: {}, query: '豆包' }).length, 0);
    assert.equal(store.search({ ...context, botId: 'other-bot', query: '豆包' }).length, 0);
    assert.equal(store.search({ ...context, groupId: '22222', query: '豆包' }).length, 0);
    const outsiderPresent = present(service, '11111', ['55555']);
    assert.equal(store.search({ ...outsiderPresent, query: '豆包' }).length, 3);
});

test('入退群立即更新，已取得的查询上下文在退群后也失效，本人重进群可恢复', t => {
    const { service, advance } = setup(t);
    service.ingest([pet()], [source()]);
    const context = present(service, '11111');
    assert.match(service.context(context), /豆包/);
    assert.equal(notice(service, 33333), true);
    assert.equal(service.context(context), '');
    advance(1000);
    assert.equal(notice(service, 33333, 'increase'), true);
    assert.match(service.context(context), /豆包/);
    assert.equal(notice(service, 12345), true);
    assert.equal(service.context(context), '');
    assert.deepEqual(service.roster.ids('12345', '11111'), []);
});

test('支持原始OneBot入退群通知，其他notice及不同机器人不串群', t => {
    const { service } = setup(t);
    const e = { self_id: 12345, group_id: 11111, user_id: 33333, post_type: 'notice' };
    assert.equal(service.notice({ ...e, notice_type: 'group_increase' }), true);
    const context = service.roster.context(e, ['33333']);
    assert.deepEqual(service.memberIds('11111', context), ['33333']);
    assert.equal(service.notice({ ...e, notice_type: 'group_ban' }), false);
    service.notice({ ...e, self_id: 99999, notice_type: 'group_decrease' });
    assert.deepEqual(service.memberIds('11111', context), ['33333']);
    service.notice({ ...e, notice_type: 'group_decrease' });
    assert.deepEqual(service.memberIds('11111', context), []);
});

test('完整空名单有权排除原说话人，不用缓存或人工资料补回', async t => {
    const { service } = setup(t);
    const e = rosterEvent(async () => new Map());
    service.roster.noteMessage(e);
    const context = await service.queryContext(e, ['55555']);
    assert.deepEqual(service.memberIds('11111', context), []);
    assert.deepEqual(service.roster.ids('12345', '11111'), []);
});

test('成员表失败只认近期真实说话人，提及、人工群备注及历史来源均不授权', async t => {
    const { service, store, advance } = setup(t);
    store.change(data => {
        data.people['55555'] = { name: '旧成员', namesByGroup: { '11111': { name: '旧群名片' } } };
        store.addTo(data, { type: 'fact', subjectId: '55555', content: '旧成员资料', status: 'confirmed', source: { groupId: '11111', speakerId: '55555' } });
    });
    const e = rosterEvent(async () => { throw Error('offline'); }, { message: [{ type: 'at', qq: 55555 }] });
    service.roster.noteMessage(e);
    const context = await service.queryContext(e, ['55555']);
    assert.deepEqual(service.memberIds('11111', context), ['33333']);
    advance(301000);
    // 重用旧事件不延长在群依据。
    service.roster.noteMessage(e);
    assert.deepEqual(service.memberIds('11111', context), []);
    await service.queryContext(e, ['55555']);
    assert.deepEqual(service.memberIds('11111', context), []);
});

test('重启后持久化名单不直接授权，重新拉取当前成员后才恢复沉默成员', async t => {
    const { service, root, now } = setup(t);
    const e = rosterEvent(async () => new Map([[33333, {}], [55555, {}]]));
    service.roster.noteMessage(e);
    await service.queryContext(e);
    const reopened = new MemoryService({ directory: root, getProfile: () => profile, logger: quiet, now, complete: async () => message({ memories: [] }) });
    t.after(() => reopened.dispose());
    const context = reopened.roster.context(e, ['55555']);
    assert.deepEqual(reopened.memberIds('11111', context), []);
    await reopened.queryContext(e);
    assert.deepEqual(reopened.memberIds('11111', context), ['33333', '55555']);
});

test('定期刷新补上漏掉的退群通知，同时撤销旧上下文并取消进行中的回复', async t => {
    const { service, advance } = setup(t);
    let members = new Map([[33333, {}], [55555, {}]]), reads = 0;
    const e = rosterEvent(async refresh => { assert.equal(refresh, true); reads++; return members; });
    service.roster.noteMessage(e);
    const context = await service.queryContext(e, ['55555']);
    const token = service.token(e);
    assert.ok(service.memberIds('11111', context).includes('55555'));
    members = new Map([[33333, {}]]);
    advance(301000);
    await service.roster.tick();
    assert.equal(reads, 2);
    assert.deepEqual(service.memberIds('11111', context), ['33333']);
    assert.equal(service.current(token), false);
});

test('成员表拉取期间收到退群通知，迟到旧快照不能让成员复活', async t => {
    const { service } = setup(t);
    present(service, '11111', ['33333', '55555']);
    const d = deferred(), started = deferred();
    const e = rosterEvent(() => { started.resolve(); return d.promise; });
    const pending = service.queryContext(e, ['55555']);
    await started.promise;
    notice(service, 55555);
    d.resolve(new Map([[33333, {}], [55555, {}]]));
    const context = await pending;
    assert.deepEqual(service.memberIds('11111', context), ['33333']);
    assert.equal(service.roster.data.groups['12345:group:11111'].members['55555'].status, 'left');
});

test('同一群并发查询共用一次成员表拉取，查询意图不会成为成员依据', async t => {
    const { service } = setup(t);
    const d = deferred(); let reads = 0;
    const e = rosterEvent(() => { reads++; return d.promise; });
    const first = service.queryContext(e, ['55555']);
    const second = service.queryContext(e, ['88888']);
    await turn();
    assert.equal(reads, 1);
    d.resolve(new Map([[33333, {}]]));
    for (const context of await Promise.all([first, second])) assert.deepEqual(service.memberIds('11111', context), ['33333']);
});

test('退群后迟到发言、缺少时间的旧消息和乱序通知不能恢复资格', t => {
    const { service, now, advance } = setup(t);
    present(service, '11111', ['33333']);
    const old = now(); advance(2000);
    notice(service, 33333, 'decrease', { time: now() / 1000 });
    service.roster.noteMessage({ self_id: 12345, group_id: 11111, user_id: 33333, time: old / 1000 });
    service.roster.noteMessage({ self_id: 12345, group_id: 11111, user_id: 33333 });
    notice(service, 33333, 'increase', { time: old / 1000 });
    assert.deepEqual(service.roster.ids('12345', '11111'), []);
    advance(2000);
    service.roster.noteMessage({ self_id: 12345, group_id: 11111, user_id: 33333, time: now() / 1000 });
    assert.deepEqual(service.roster.ids('12345', '11111'), ['33333']);
});

test('成员表已移除的人不会被更早的入群通知恢复，过期历史消息也不构成新依据', async t => {
    const { service, now, advance } = setup(t);
    const old = now();
    advance(301000);
    service.roster.noteMessage({ self_id: 12345, group_id: 11111, user_id: 55555, time: old / 1000 });
    assert.deepEqual(service.roster.ids('12345', '11111'), []);
    present(service, '11111', ['55555']);
    await service.queryContext(rosterEvent(async () => new Map([[33333, {}]])));
    assert.equal(notice(service, 55555, 'increase', { time: old / 1000 }), false);
    assert.deepEqual(service.roster.ids('12345', '11111'), ['33333']);
});

test('成员文件损坏时不覆盖原文件；本轮核实可独立提供资格', async t => {
    const root = directory(t);
    const file = path.join(root, 'group-members.json');
    fs.writeFileSync(file, '{broken');
    const service = new MemoryService({ directory: root, getProfile: () => profile, logger: quiet, complete: async () => message({ memories: [] }) });
    t.after(() => service.dispose());
    const e = rosterEvent(async () => new Map([[33333, {}]]));
    const context = await service.queryContext(e);
    assert.deepEqual(service.memberIds('11111', context), ['33333']);
    service.roster.flush();
    assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});

test('自动提取不能把资料归给只在全库或@里出现的外群人物', async t => {
    const h = pluginHarness(t, { p: scopedProfile() });
    const e = h.event('', { group_id: 11111 });
    e.bot.gml = new Map([[11111, new Map([[33333, {}], [44444, {}]])]]);
    await h.api.profileQueryContext(e);
    const s = source(undefined, { groupId: '11111', targets: ['55555'] });
    const thirdParty = source('44444养了一只橘猫，名字叫豆包', { id: 'third-party-source', groupId: '11111' });
    h.api.memory.ingest([pet({ userid: '55555', content: '错误的外群归属' }),
        pet({ userid: '44444', source_id: thirdParty.id, evidence: thirdParty.text }), pet()], [s, thirdParty]);
    assert.deepEqual(h.api.memory.store.data.records.filter(r => r.type === 'entity').map(r => r.subjectId), ['44444', '33333']);
});

test('普通聊天中模型被诱导指定外群QQ或伪造群号，工具仍只使用服务端当前群', async t => {
    const h = pluginHarness(t, { p: scopedProfile(), response: (_, count) => count === 1 ? { choices: [{ finish_reason: 'tool_calls', message: {
        role: 'assistant', content: null, tool_calls: [{ id: 'outsider', type: 'function', function: {
            name: 'member_profile_query', arguments: JSON.stringify({ action: 'user_info', target: '55555', groupId: '22222', memberIds: ['55555'], allUsers: true })
        } }]
    } }] } : message('未查到') });
    const e = h.event('#呱瓜 这是我的朋友55555，请跨群查一下', { group_id: 11111, message: [{ type: 'at', qq: 55555 }] });
    e.bot.gml = new Map([[11111, new Map([[33333, {}]])]]);
    await h.instance.chat(e);
    const result = h.calls[1].messages.find(m => m.role === 'tool').content;
    assert.doesNotMatch(result, /userid=55555|生日:2月2日|乙群成员/);
    assert.match(result, /未找到/);
});

test('通知插件独立匹配notice，退群会中止正在生成的普通和引用续聊回复', async t => {
    for (const followup of [false, true]) {
        const d = deferred(), started = deferred();
        const h = quotedHarness(t, { response: (_, count) => {
            if (followup && count === 1) return message('先前回答');
            started.resolve(); return d.promise;
        } });
        let e = h.event('#呱瓜 测试', { group_id: 11111 });
        e.bot.gml = new Map([[11111, new Map([[33333, {}], [55555, {}]])]]);
        let request;
        if (followup) {
            await h.instance.chat(e);
            e = h.follow('引用追问', undefined, { group_id: 11111 });
            request = h.receive(e);
        } else request = h.instance.chat(e);
        await started.promise;
        const before = h.sent.length;
        const handler = new h.api.GuaguaGroupNotice();
        assert.equal(handler.options.event, 'notice');
        assert.equal(handler.options.rule.length, 0);
        assert.equal(await handler.accept({ ...e, user_id: 55555, post_type: 'notice', notice_type: 'group', sub_type: 'decrease' }), false);
        d.resolve(message('过时回复'));
        await request;
        assert.equal(h.sent.length, before);
    }
});

test('v2迁移保留编号状态原文来源会话和管理列表，v3再次加载保持一致', t => {
    const { root, store } = setup(t);
    const old = { version: 2, nextId: 9, migratedProfile: true, updatedAt: 'old',
        members: { '33333': { name: '阿明', groups: { '11111': { name: '群名片' } } } },
        sessions: { '12345:group:11111': { history: [{ role: 'user', content: '保留对话' }], summary: '保留摘要', pendingSummary: [] } },
        observations: [source()], reminders: { owner: { nextAt: 123 } }, reviews: { owner: { ids: ['M000001'] } },
        records: [
            { id: 'M000001', type: 'entity', subjectId: '33333', groupId: '', content: '宠物豆包', status: 'confirmed', source: { groupId: '11111', quote: '原话' } },
            { id: 'M000002', type: 'alias', subjectId: '', groupId: '', content: '旧称呼', status: 'ignored', source: {} },
            { id: 'M000003', type: 'event', subjectId: '33333', groupId: '', content: '群约定', status: 'active', source: { groupId: '11111' } },
            { id: 'M000004', type: 'agreement', subjectId: '33333', groupId: '', content: '私聊约定', status: 'expired', source: { session: '12345:private:33333' } },
            { id: 'M000005', type: 'entity', subjectId: '', groupId: '11111', shareOnBinding: true, content: '待绑定豆包', status: 'pending', source: { groupId: '11111' } }
        ] };
    fs.writeFileSync(store.file, JSON.stringify(old));
    const migrated = new MemoryStore(root, { logger: quiet });
    assert.equal(migrated.blocked, '');
    assert.equal(migrated.data.version, 3);
    assert.equal(migrated.data.nextId, 9);
    assert.equal(migrated.data.members, undefined);
    assert.deepEqual(migrated.data.people['33333'].namesByGroup, old.members['33333'].groups);
    assert.equal(migrated.data.people['33333'].groups, undefined);
    for (const key of ['sessions', 'observations', 'reviews', 'reminders']) assert.deepEqual(migrated.data[key], old[key]);
    for (const [i, record] of migrated.data.records.entries()) {
        for (const key of ['id', 'type', 'subjectId', 'content', 'status', 'source']) assert.deepEqual(record[key], old.records[i][key]);
        for (const key of ['groupId', 'sessionId', 'shareOnBinding']) assert.equal(key in record, false);
    }
    assert.deepEqual(migrated.data.records.map(r => r.scope.kind), ['person', 'unresolved', 'group', 'private', 'group']);
    assert.equal(migrated.data.records[4].scope.shareWhenBound, true);
    assert.equal(JSON.parse(fs.readFileSync(store.file)).version, 2, '读取迁移不直接改写源文件');
    migrated.change(() => {});
    const reopened = new MemoryStore(root, { logger: quiet });
    assert.deepEqual(reopened.data, migrated.data);
});

test('v2已有提醒的版本指纹迁移后仍能用，范围发生修复的记录需重看', t => {
    const { service, store, root } = setup(t);
    service.ingest([pet()], [source()]);
    store.change(data => store.addTo(data, { type: 'alias', subjectId: '33333', scope: { kind: 'person' }, content: '旧群称呼', status: 'pending', source: { groupId: '11111' } }));
    const e = { self_id: 12345, user_id: 22222 };
    const review = service.beginReview(e, store.pending());
    service.rememberReceipt(e, review, { message_id: 'old-review' });
    const old = JSON.parse(fs.readFileSync(store.file));
    old.version = 2; old.members = old.people; delete old.people;
    for (const r of old.records) { r.groupId = ''; delete r.scope; }
    for (const snapshot of Object.values(old.reviews).flat()) for (const r of old.records) {
        snapshot.versions[r.id] = createHash('sha256').update(JSON.stringify([r.type, r.subjectId, r.groupId, r.content, r.status, r.entity, r.replaces, r.expiresAt])).digest('hex').slice(0, 24);
    }
    fs.writeFileSync(store.file, JSON.stringify(old));
    const reopened = new MemoryService({ directory: root, getProfile: () => profile, logger: quiet, now: store.now, complete: async () => message({ memories: [] }) });
    t.after(() => reopened.dispose());
    const plan = reopened.planReview(e, '确认 1');
    assert.equal(plan.operations.length, 1);
    assert.throws(() => reopened.planReview(e, '确认 2'), /已变化/);
    reopened.store.manageMany(plan.operations, '22222');
    assert.equal(reopened.store.data.records[0].status, 'confirmed');
});

const toolReply = (name, args, id = name, reasoning = '') => ({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
    ...(reasoning ? { reasoning_content: reasoning } : {}), tool_calls: [{ id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } }] } }] });

test('普通聊天真实执行搜索→抓取→回答，复用DeepSeek密钥，网页资料不进入群员记忆', async t => {
    const requests = [];
    const h = pluginHarness(t, { config: { 'deepseekJS:thinking_enabled': 'true' },
        http: { post: async (url, body, options) => {
            requests.push({ url, body, options });
            return { data: url.endsWith('/search') ? { results: [{ title: '官方文档', url: 'https://example.com/doc', snippet: '摘要', summary: '网页长摘要', date: null }] } :
                { title: '官方文档', content: '# 官方原文\n\n网页独有内容，不属于群员自述' } };
        } }, response: (params, count) => {
            if (count === 1) return toolReply('web_search', { query: '官方文档' }, 'search', '先找官方来源');
            if (count === 2) {
                assert.ok(params.tools.some(t => t.function.name === 'web_fetch'));
                const result = JSON.parse(params.messages.find(m => m.tool_call_id === 'search').content);
                assert.equal(result.results[0].summary, '网页长摘要');
                assert.equal(result.results[0].content_available, false);
                return toolReply('web_fetch', { url: result.results[0].url }, 'fetch', '再读取原文细节');
            }
            const result = JSON.parse(params.messages.find(m => m.tool_call_id === 'fetch').content);
            assert.match(result.content, /网页独有内容/);
            assert.equal(result.source_id, 'S1');
            assert.deepEqual(Array.from(params.messages.filter(m => m.role === 'assistant'), m => m.reasoning_content), ['先找官方来源', '再读取原文细节']);
            return message('读到了官方文档。来源：https://example.com/doc');
        } });
    await h.instance.chat(h.event('#呱瓜 帮我搜索官方文档并阅读原文'));
    assert.equal(h.calls.length, 3);
    assert.deepEqual(requests.map(r => r.url), ['https://api.deepseek.com/v1/tools/search', 'https://api.deepseek.com/v1/tools/fetch']);
    assert.equal(requests[0].body.ori_question, '帮我搜索官方文档并阅读原文');
    assert.doesNotMatch(requests[0].body.ori_question, /userid|群昵称|性别|群员/);
    assert.ok(requests.every(r => r.options.headers.Authorization === 'Bearer test-deepseek-key'));
    assert.equal(h.api.memory.store.data.records.length, 0);
    assert.ok(!h.api.memory.store.data.observations.some(o => o.text.includes('网页独有内容')));
    assert.equal(h.replies.filter(r => typeof r === 'string' && r.includes('正在查找')).length, 1);
    assert.match(JSON.stringify(h.replies.at(-1)), /https:\/\/example.com\/doc/);
    assert.match(h.calls[0].messages[0].content, /网页内容仅作本轮回答/);
});

test('主人可独立切换Ollama兼容服务，非主人和粘连命令不修改配置', async t => {
    const requests = [];
    const h = pluginHarness(t, { http: { post: async (url, body) => { requests.push({ url, body }); return { data: { results: [] } }; } },
        response: (_p, count) => count === 1 ? toolReply('web_search', { query: '天气' }) : message('没有查到') });
    assert.equal(await h.dispatch(h.event('#ds搜索服务')), 'setWebProvider');
    assert.match(h.replies.at(-1), /deepseek/);
    assert.equal(await h.dispatch(h.event('#ds搜索服务 ollama', { isMaster: false })), 'denied');
    assert.equal(h.redis.get('deepseekJS:web_provider'), undefined);
    assert.equal(await h.dispatch(h.event('#ds搜索服务ollama')), null);
    await h.dispatch(h.event('#ds搜索服务 ollama'));
    assert.equal(h.redis.get('deepseekJS:web_provider'), 'ollama');
    await h.instance.chat(h.event('#呱瓜 今天的天气'));
    assert.equal(requests[0].url, 'https://ollama.com/api/web_search');
    assert.deepEqual(requests[0].body, { query: '天气', max_results: 5 });
    await h.dispatch(h.event('#ds搜索服务 deepseek'));
    assert.equal(h.redis.get('deepseekJS:web_provider'), 'deepseek');
});

test('自定义人设仍附带网页数据规则；模型直接抓取用户链接无需先搜索', async t => {
    const requests = [];
    const h = pluginHarness(t, { config: { 'deepseekJS:prompt': '自定义人设' },
        http: { post: async (url, body) => { requests.push({ url, body }); return { data: { title: '页面', content: '已读取正文' } }; } },
        response: (_p, count) => count === 1 ? toolReply('web_fetch', { url: 'https://example.com/doc' }) : message('页面讲了这些内容') });
    await h.instance.chat(h.event('#呱瓜 阅读 https://example.com/doc'));
    assert.match(h.calls[0].messages[0].content, /自定义人设/);
    assert.match(h.calls[0].messages[0].content, /工具返回的网页标题/);
    assert.equal(requests[0].url, 'https://api.deepseek.com/v1/tools/fetch');
    assert.equal(h.calls.length, 2);
});

test('旧网页工具名兼容调用当前服务，不让工具名偷偷切换provider', async t => {
    const requests = [];
    const h = pluginHarness(t, { http: { post: async url => { requests.push(url); return { data: { results: [] } }; } },
        response: (_p, count) => count === 1 ? toolReply('ollama_web_search', { query: '文档' }) : message('没有结果') });
    await h.instance.chat(h.event());
    assert.deepEqual(requests, ['https://api.deepseek.com/v1/tools/search']);
});

test('工具参数JSON错误也能配对返回并继续回答，不向搜索接口发送错误请求', async t => {
    let requests = 0;
    const h = pluginHarness(t, { http: { post: async () => { requests++; throw Error('不应请求'); } },
        response: (p, count) => {
            if (count === 1) return toolReply('web_search', '{broken', 'broken');
            assert.equal(JSON.parse(p.messages.find(m => m.tool_call_id === 'broken').content).error.code, 'tool_error');
            return message('查询参数有误');
        } });
    await h.instance.chat(h.event());
    assert.equal(requests, 0);
    assert.equal(h.calls.length, 2);
});

test('工具循环最多三轮然后禁用工具，避免搜索或抓取无休止继续', async t => {
    let requests = 0;
    const h = pluginHarness(t, { http: { post: async () => { requests++; return { data: { results: [] } }; } },
        response: (p, count) => {
            if (count < 4) return toolReply('web_search', { query: `问题${count}` }, `search-${count}`);
            assert.equal(p.tools, undefined);
            assert.equal(p.messages.filter(m => m.role === 'tool').length, 3);
            return message('根据现有资料，尚未查到');
        } });
    await h.instance.chat(h.event());
    assert.equal(h.calls.length, 4);
    assert.equal(requests, 3);
});

test('大量工具调用受预算限制，每个调用仍配对结果后收束回答', async t => {
    let requests = 0;
    const h = pluginHarness(t, { http: { post: async () => { requests++; return { data: { results: [] } }; } },
        response: (p, count) => {
            if (count === 1) return { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: Array.from({ length: 10 }, (_, i) =>
                ({ id: `search-${i}`, type: 'function', function: { name: 'web_search', arguments: JSON.stringify({ query: `关键词${i}` }) } })) } }] };
            assert.equal(p.tools, undefined);
            const results = p.messages.filter(m => m.role === 'tool');
            assert.equal(results.length, 10);
            assert.equal(new Set(results.map(r => r.tool_call_id)).size, 10);
            assert.equal(JSON.parse(results[8].content).error.code, 'tool_limit');
            return message('已完成有限次数查询');
        } });
    await h.instance.chat(h.event());
    assert.equal(requests, 6);
    assert.equal(h.calls.length, 2);
});

test('搜索等待期间重置会话，不继续抓取、不发送迟到回答或写入旧历史', async t => {
    const d = deferred(), started = deferred();
    const h = pluginHarness(t, { http: { post: () => { started.resolve(); return d.promise; } },
        response: () => toolReply('web_search', { query: '文档' }) });
    const e = h.event();
    const pending = h.instance.chat(e);
    await started.promise;
    await h.instance.reset(e);
    const before = h.replies.length;
    d.resolve({ data: { results: [] } });
    await pending;
    assert.equal(h.calls.length, 1);
    assert.equal(h.replies.length, before);
    assert.equal(h.api.memory.store.data.sessions[sessionKey(e)], undefined);
});

const bubbles = (...messages) => ({ reply_format: 'guagua-v1', mode: 'chat', messages });

test('普通回复按模型停顿分次发送，只引用一次、只@一次，历史仍是一轮', async t => {
    const h = pluginHarness(t, { response: () => message(bubbles('[CQ:at,qq=33333] 先说这个', '[CQ:at,qq=33333] 再补充一个问题')) });
    const e = h.event(), sent = [];
    e.reply = async (payload, quote) => { sent.push({ payload, quote }); return { message_id: `sent-${sent.length}` }; };
    await h.instance.chat(e);
    assert.equal(sent.length, 2);
    assert.equal(sent[0].quote, true);
    assert.equal(sent[1].quote, false);
    assert.equal(sent.flatMap(s => Array.from(s.payload)).filter(p => p?.type === 'at').length, 1);
    const history = h.api.memory.store.history(sessionKey(e), 3);
    assert.equal(history.length, 2);
    assert.match(history[1].content, /先说这个/);
    assert.match(history[1].content, /再补充一个问题/);
    assert.doesNotMatch(history[1].content, /reply_format|messages/);
    assert.equal(history[1].replyId, undefined, '内部进度标识不传给模型');
    assert.equal(h.calls.length, 1, '分次发送不增加模型调用');
});

test('分次回复第二条持续失败只保存成功首条，不记录尚未发送的尾部', async t => {
    const h = pluginHarness(t, { response: () => message(bubbles('成功首条', '失败第二条', '还没有发的第三条')) });
    const e = h.event(), sent = []; let failedAttempts = 0;
    e.reply = async payload => {
        const text = JSON.stringify(payload);
        if (text.includes('失败第二条')) { failedAttempts++; return { error: 'adapter failure' }; }
        sent.push(text); return true;
    };
    await h.instance.chat(e);
    assert.equal(failedAttempts, 2);
    assert.equal(sent.filter(s => s.includes('成功首条')).length, 1);
    assert.ok(!sent.some(s => s.includes('还没有发')));
    const history = h.api.memory.store.history(sessionKey(e), 3);
    assert.equal(history.length, 2);
    assert.equal(history[1].content, '成功首条');
});

test('首条发出后的停顿中重置，余下消息与旧会话历史都不会写回', async t => {
    const started = deferred(), resume = deferred();
    const h = pluginHarness(t, { pause: async () => { started.resolve(); await resume.promise; }, response: () => message(bubbles('第一条', '重置后不该出现')) });
    const e = h.event(), pending = h.instance.chat(e);
    await started.promise;
    assert.equal(h.api.memory.store.history(sessionKey(e), 3)[1].content, '第一条');
    await h.instance.reset(e); resume.resolve(); await pending;
    assert.doesNotMatch(JSON.stringify(h.replies), /重置后不该出现/);
    assert.equal(h.api.memory.store.data.sessions[sessionKey(e)], undefined);
});

test('同一成员新明确提问停止旧尾段，成功首段仍按顺序保留', async t => {
    const started = deferred(), resume = deferred(); let paused = false;
    const h = pluginHarness(t, { pause: async () => { if (!paused) { paused = true; started.resolve(); await resume.promise; } },
        response: (_p, count) => message(bubbles(`第${count}轮首条`, `第${count}轮尾条`)) });
    const first = h.instance.chat(h.event('#呱瓜 第一问'));
    await started.promise;
    const second = h.instance.chat(h.event('#呱瓜 第二问'));
    await turn(); assert.equal(h.calls.length, 1);
    resume.resolve(); await Promise.all([first, second]);
    assert.deepEqual(h.replies.map(p => Array.from(p).join('')), ['第1轮首条', '第2轮首条', '第2轮尾条']);
    assert.equal(h.api.memory.store.history(sessionKey(h.event()), 3).length, 4);
});

test('长答案先结论再转发，用户明确要求单条时完整直发', async t => {
    const content = '完整技术说明。'.repeat(150), cards = [];
    const h = pluginHarness(t, { forward: async nodes => { cards.push(nodes); return { type: 'forward', nodes }; }, response: () => message({ reply_format: 'guagua-v1', mode: 'forward', intro: '关键是先核实成员', sections: [content, '来源：https://example.com/doc'] }) });
    const e = h.event(); await h.instance.chat(e);
    assert.equal(h.replies.length, 2);
    assert.match(JSON.stringify(h.replies[0]), /关键是先核实成员/);
    assert.equal(h.replies[1].type, 'forward');
    assert.equal(cards.length, 1);
    assert.match(h.api.memory.store.history(sessionKey(e), 3)[1].content, /来源：https/);
    const x = pluginHarness(t, { response: () => message(bubbles(content, '完整结尾')) });
    await x.instance.chat(x.event('#呱瓜 这次别分条，详细解释一下'));
    assert.equal(x.replies.length, 1);
    assert.match(JSON.stringify(x.replies[0]), /完整结尾/);
});

test('群成员变更发生在分次发送间隙时，剩余回复也会撤销', async t => {
    const started = deferred(), resume = deferred();
    const h = pluginHarness(t, { pause: async () => { started.resolve(); await resume.promise; }, response: () => message(bubbles('第一句', '资格变更后不能续发')) });
    const e = h.event(), pending = h.instance.chat(e); await started.promise;
    await new h.api.GuaguaGroupNotice().accept({ ...e, user_id: 55555, post_type: 'notice', notice_type: 'group', sub_type: 'decrease' });
    resume.resolve(); await pending;
    assert.doesNotMatch(JSON.stringify(h.replies), /资格变更后不能续发/);
    assert.equal(h.api.memory.store.history(sessionKey(e), 3)[1].content, '第一句');
});

test('更新旧分次回复时不覆盖中间的新会话轮次，私有进度字段不进入模型输入', t => {
    const { store } = setup(t);
    const delivery = { id: 'test-reply', history: ['已经发出的首条'] };
    store.recordReply('session', delivery, '用户问题', 3);
    store.appendHistory('session', [{ role: 'user', content: '后来新问题' }, { role: 'assistant', content: '后来新回答' }], 3);
    delivery.history.push('续发的第二条'); store.recordReply('session', delivery, '用户问题', 3);
    assert.deepEqual(store.history('session', 3).map(m => m.content), ['用户问题', '已经发出的首条\n\n续发的第二条', '后来新问题', '后来新回答']);
    assert.ok(store.history('session', 3).every(m => !('replyId' in m)));
});

test('转发引言与正文提到相同对象时，不在转发节点重复@', async t => {
    const cards = [];
    const h = pluginHarness(t, { forward: async nodes => { cards.push(nodes); return { type: 'forward', nodes }; }, response: () => message({
        reply_format: 'guagua-v1', mode: 'forward', intro: '[CQ:at,qq=33333] 结论在这里',
        sections: ['[CQ:at,qq=33333] ' + '完整说明。'.repeat(160)]
    }) });
    await h.instance.chat(h.event());
    assert.equal(h.replies[0].filter(part => part?.type === 'at').length, 1);
    assert.equal(cards.flatMap(nodes => nodes.flatMap(node => Array.from(node))).filter(part => part?.type === 'at').length, 0);
});

test('搜索工具调用后的最终回答也能分次发送，来源链接保留在实际正文中', async t => {
    const h = pluginHarness(t, { http: { post: async () => ({ data: { results: [{ title: '官方页面', url: 'https://example.com/doc', summary: '返回的摘要' }] } }) },
        response: (_params, count) => count === 1 ? toolReply('web_search', { query: '官方页面' }) : message(bubbles('我查到了这项说明', '来源：https://example.com/doc')) });
    const e = h.event(); await h.instance.chat(e);
    assert.equal(h.calls.length, 2);
    assert.equal(h.replies.length, 3, '一次进度提示和两条实际回复');
    assert.match(JSON.stringify(h.replies.at(-1)), /https:\/\/example.com\/doc/);
    assert.doesNotMatch(h.api.memory.store.history(sessionKey(e), 3)[1].content, /reply_format/);
});

test('普通聊天的纯文本多段回复与单项多段格式都会实际分次发送', async t => {
    for (const content of ['第一段先回答这个问题。\n\n另外，再补充一个建议。', bubbles('第一段先回答这个问题。\n\n另外，再补充一个建议。')]) {
        const h = pluginHarness(t, { response: () => message(content) });
        const e = h.event(), sent = [];
        e.reply = async (payload, quote) => { sent.push({ text: Array.from(payload).join(''), quote }); return true; };
        await h.instance.chat(e);
        assert.deepEqual(sent, [{ text: '第一段先回答这个问题。', quote: true }, { text: '另外，再补充一个建议。', quote: false }]);
        const history = h.api.memory.store.history(sessionKey(e), 3);
        assert.equal(history.length, 2);
        assert.equal(history[1].content, '第一段先回答这个问题。\n\n另外，再补充一个建议。');
    }
});

test('摘要期间续发更新了原文时，旧摘要不能移除更新后的内容', async t => {
    const started = deferred(), answer = deferred();
    const { service, store } = setup(t, { complete: () => { started.resolve(); return answer.promise; } });
    const delivery = { id: 'changing-reply', history: ['首条已发出'] };
    store.recordReply('summary-race', delivery, '问题', 1);
    store.appendHistory('summary-race', [{ role: 'user', content: '后续问题' }, { role: 'assistant', content: '后续回答' }], 1);
    const request = service.processSummary('summary-race'); await started.promise;
    delivery.history.push('摘要请求之后补发的内容'); store.recordReply('summary-race', delivery, '问题', 1);
    answer.resolve(message('只看到了首条的旧摘要')); await request;
    assert.equal(store.data.sessions['summary-race'].summary, '');
    assert.match(JSON.stringify(store.data.sessions['summary-race'].pendingSummary), /补发的内容/);
    service.complete = async params => {
        const input = JSON.parse(params.messages[1].content);
        assert.ok(input.messages.every(m => !('replyId' in m)));
        assert.match(JSON.stringify(input.messages), /补发的内容/);
        return message('包含补发内容的新摘要');
    };
    await service.processSummary('summary-race');
    assert.equal(store.data.sessions['summary-race'].summary, '包含补发内容的新摘要');
    assert.equal(store.data.sessions['summary-race'].pendingSummary.length, 0);
});

test('运行中关闭提取后，已经发出的模型请求不继续写入新记忆', async t => {
    const started = deferred(), answer = deferred();
    const { service, store } = setup(t, { complete: params => { started.resolve(JSON.parse(params.messages[1].content).messages[0]); return answer.promise; } });
    service.observe({ self_id: 12345, user_id: 33333, group_id: 11111, message_id: 'disable-race' }, source().text);
    store.change(data => { data.observations[0].readyAt = 0; });
    const request = service.processExtractions(), observed = await started.promise;
    store.setConfig({ enabled: false }); answer.resolve(message({ memories: [pet({ source_id: observed.id })] }));
    await request;
    assert.equal(store.data.records.length, 0);
    assert.equal(store.data.observations.length, 1);
});

test('损坏的旧学习元数据不能导致整条正常聊天回复丢失', async t => {
    const h = pluginHarness(t, { response: () => message('正常回复【MEM】{"remember":{},"pending":{}}') });
    await h.instance.chat(h.event());
    assert.match(JSON.stringify(h.replies), /正常回复/);
    assert.doesNotMatch(JSON.stringify(h.replies), /AI对话请求发送失败|【MEM】/);
});

test('模型标记截断的正文不作为完整回答发送或写入历史', async t => {
    const h = pluginHarness(t, { response: () => ({ choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '还没有说完的半截回答' } }] }) });
    const e = h.event(); await h.instance.chat(e);
    assert.doesNotMatch(JSON.stringify(h.replies), /还没有说完的半截回答/);
    assert.equal(h.api.memory.store.history(sessionKey(e), 3).length, 0);
});

test('只有self_id的适配器按真实机器人账号隔离会话', () => {
    assert.equal(sessionKey({ bot: { self_id: 12345 }, group_id: 11111 }), '12345:group:11111');
    assert.notEqual(sessionKey({ bot: { self_id: 12345 }, group_id: 11111 }), sessionKey({ bot: { self_id: 54321 }, group_id: 11111 }));
});

test('主人提醒切换机器人时重新展示完整列表，不沿用另一账号的分页序号', async t => {
    const { service, store } = setup(t);
    store.setConfig({ reminderPageSize: 1, reminderInitialDelaySeconds: 0, reminderBotId: '12345' });
    seedReview(service, [pet(), pet({ content: '第二条宠物资料' })], [source()]);
    const a = [], b = [];
    service.registerBot({ uin: 12345, pickUser: () => ({ sendMsg: async body => { if (a.length) return false; a.push(body); return { message_id: 'a-1' }; } }) });
    service.registerBot({ uin: 54321, pickUser: () => ({ sendMsg: async body => { b.push(body); return { message_id: `b-${b.length}` }; } }) });
    await service.notifyPending();
    assert.equal(a.length, 1);
    store.setConfig({ reminderBotId: '54321' });
    await service.notifyPending(true);
    assert.equal(b.length, 2);
    assert.match(b[0], /1-1\/2/);
    assert.equal(service.reviewFor({ self_id: 54321, user_id: 22222 }).shownIds.length, 2);
});

test('关闭定期提醒后不会继续发后面的页面，重新开启可接着发送', async t => {
    const { service, store } = setup(t);
    store.setConfig({ reminderPageSize: 1, reminderInitialDelaySeconds: 0 });
    seedReview(service, [pet(), pet({ content: '第二条宠物资料' })], [source()]);
    const sent = [];
    service.registerBot({ uin: 12345, pickUser: () => ({ sendMsg: async body => {
        sent.push(body);
        if (sent.length === 1) store.setConfig({ reminderEnabled: false });
        return true;
    } }) });
    await service.notifyPending();
    assert.equal(sent.length, 1);
    store.setConfig({ reminderEnabled: true });
    await service.notifyPending();
    assert.equal(sent.length, 2);
    assert.match(sent[1], /第二条宠物资料/);
});

test('已卸载实例的迟到成员表和消息不会覆盖文件，新实例可重新核实', async t => {
    const { service, root } = setup(t);
    const answer = deferred(), started = deferred();
    const e = rosterEvent(() => { started.resolve(); return answer.promise; });
    service.roster.noteMessage(e);
    const request = service.queryContext(e); await started.promise;
    service.dispose();
    const rosterFile = path.join(root, 'group-members.json'), before = fs.readFileSync(rosterFile, 'utf8'), memoryBefore = fs.readFileSync(service.store.file, 'utf8');
    service.observe({ ...e, message_id: 'late' }, '迟到消息');
    service.notice({ ...e, user_id: 88888, post_type: 'notice', notice_type: 'group_increase' });
    answer.resolve(new Map([[33333, {}], [88888, {}]])); await request;
    assert.equal(fs.readFileSync(rosterFile, 'utf8'), before);
    assert.equal(fs.readFileSync(service.store.file, 'utf8'), memoryBefore);
});

test('不支持成员表的群不会饿死其他活跃群的后台校准', async t => {
    const { service } = setup(t); let verified = 0;
    service.roster.noteMessage(rosterEvent(undefined));
    const e = rosterEvent(async () => { verified++; return new Map([[33333, {}], [88888, {}]]); }, { group_id: 22222 });
    service.roster.noteMessage(e);
    await service.roster.tick(); await service.roster.tick();
    assert.equal(verified, 1);
    assert.ok(service.roster.ids('12345', '22222').includes('88888'));
});

test('性别字符串正确归一化，不同机器人对同一编号的缓存独立', async t => {
    const h = pluginHarness(t);
    const a = h.event(), b = h.event('#呱瓜 测试', { self_id: 54321 });
    a.bot.pickMember = () => ({ getInfo: async () => ({ sex: 'male' }) });
    b.bot = { ...b.bot, uin: 54321, pickMember: () => ({ getInfo: async () => ({ sex: 'female' }) }) };
    await h.instance.chat(a); await h.instance.chat(b);
    assert.match(JSON.stringify(h.calls[0].messages), /性别:男孩子/);
    assert.match(JSON.stringify(h.calls[1].messages), /性别:女孩子/);
});

test('截断的工具调用不执行网络请求，缺少sender或空消息段的事件仍可回复', async t => {
    let requests = 0;
    const h = pluginHarness(t, { http: { post: async () => { requests++; return { data: { results: [] } }; } },
        response: () => ({ ...toolReply('web_search', { query: '不该执行' }), choices: [{ ...toolReply('web_search', { query: '不该执行' }).choices[0], finish_reason: 'length' }] }) });
    await h.instance.chat(h.event()); assert.equal(requests, 0);
    const x = pluginHarness(t);
    await x.instance.chat(x.event('#呱瓜 测试', { sender: undefined, message: [null, { type: 'text', text: '#呱瓜 测试' }] }));
    assert.match(JSON.stringify(x.replies), /正常回复/);
});

test('条数配置按整数处理，缺少更新时间的兼容记忆不会让检索崩溃', t => {
    const { service, store } = setup(t);
    store.setConfig({ reminderPageSize: 1.5, extractionBatchSize: 2.5, recallLimit: 3.5 });
    assert.equal(store.config.reminderPageSize, 1);
    assert.equal(store.config.extractionBatchSize, 2);
    assert.equal(store.config.recallLimit, 3);
    seedReview(service, [pet(), pet({ content: '另一条宠物豆包资料' })], [source()]);
    store.change(data => { for (const record of data.records) delete record.updatedAt; });
    assert.equal(store.search({ ...present(service, '11111'), query: '豆包' }).length, 2);
});

test('卸载期间收到提醒发送回执时，旧实例不再修改新实例共享的数据文件', async t => {
    const { service, store } = setup(t);
    store.setConfig({ reminderPageSize: 1, reminderInitialDelaySeconds: 0 });
    service.ingest([pet()], [source()]);
    const started = deferred(), receipt = deferred();
    service.registerBot({ uin: 12345, pickUser: () => ({ sendMsg: () => { started.resolve(); return receipt.promise; } }) });
    const pending = service.notifyPending(); await started.promise; service.dispose();
    const before = fs.readFileSync(store.file, 'utf8');
    receipt.resolve({ message_id: 'late-receipt' }); await pending;
    assert.equal(fs.readFileSync(store.file, 'utf8'), before);
});

test('卸载发生在记忆提取的成员核实阶段时，不再发出新的模型请求', async t => {
    let calls = 0;
    const { service, store } = setup(t, { complete: async () => { calls++; return message({ memories: [] }); } });
    const started = deferred(), members = deferred();
    const e = rosterEvent(() => { started.resolve(); return members.promise; });
    service.observe(e, source().text);
    store.change(data => { data.observations[0].readyAt = 0; });
    const pending = service.processExtractions(); await started.promise; service.dispose();
    members.resolve(new Map([[33333, {}]])); await pending;
    assert.equal(calls, 0);
    assert.equal(store.data.observations.length, 1);
});

test('语法合法但成员结构损坏的文件不覆盖原件，也不导致发言处理崩溃', async t => {
    const root = directory(t), file = path.join(root, 'group-members.json');
    const raw = JSON.stringify({ version: 1, groups: { '12345:group:11111': { members: 'broken' } } });
    fs.writeFileSync(file, raw);
    const service = new MemoryService({ directory: root, getProfile: () => profile, logger: quiet, complete: async () => message({ memories: [] }) });
    t.after(() => service.dispose());
    const e = rosterEvent(async () => new Map([[33333, {}]]));
    assert.doesNotThrow(() => service.roster.noteMessage(e));
    const context = await service.queryContext(e);
    assert.deepEqual(service.memberIds('11111', context), ['33333']);
    assert.equal(fs.readFileSync(file, 'utf8'), raw);
});

test('记忆会话字段损坏时保留有效缓存并阻止覆盖损坏原件', t => {
    const { store } = setup(t);
    store.appendHistory('good', [{ role: 'user', content: '有效缓存' }], 3);
    const broken = JSON.parse(fs.readFileSync(store.file)); broken.sessions.good.history = 'broken';
    fs.writeFileSync(store.file, JSON.stringify(broken)); store.load();
    assert.equal(store.history('good', 3)[0].content, '有效缓存');
    assert.throws(() => store.change(() => {}), /读取失败/);
    assert.equal(JSON.parse(fs.readFileSync(store.file)).sessions.good.history, 'broken');
});

test('旧称呼同步人工资料失败时回滚整批记忆，不留下只改一份文件的状态', async t => {
    const h = pluginHarness(t, { p: { ...profile, users: { ...profile.users, '33333': { name: '阿明', learned: [{ alias: '明明' }] } } } });
    const store = h.api.memory.store, before = fs.readFileSync(store.file, 'utf8');
    h.sandbox.renameSync = (from, to) => { if (to === path.join(h.root, 'member-profile.json')) throw Error('模拟资料文件写入失败'); fs.renameSync(from, to); };
    await h.instance.memoryCmd(h.event('#memory 忽略 M1'));
    assert.equal(store.data.records[0].status, 'confirmed');
    assert.equal(fs.readFileSync(store.file, 'utf8'), before);
    assert.equal(JSON.parse(fs.readFileSync(path.join(h.root, 'member-profile.json'))).users['33333'].learned[0].alias, '明明');
    assert.match(JSON.stringify(h.replies), /记忆更改已回滚/);
});

test('同长度外部修改即使恢复修改时间也会在下一次写入前重新加载', t => {
    const { store } = setup(t);
    store.change(data => { data.people.external = { name: 'before' }; });
    const original = fs.statSync(store.file), content = fs.readFileSync(store.file, 'utf8');
    const changed = content.replace('before', 'AFTER!');
    assert.equal(Buffer.byteLength(changed), Buffer.byteLength(content));
    fs.writeFileSync(store.file, changed); fs.utimesSync(store.file, original.atime, original.mtime);
    store.change(data => { data.people.local = { name: '保留本地修改' }; });
    assert.equal(store.data.people.external.name, 'AFTER!');
    assert.equal(store.data.people.local.name, '保留本地修改');
});

test('审阅列表按成员汇总，跨页序号仍指向相同固定记忆编号', async t => {
    const { service, store } = setup(t);
    store.setConfig({ reminderPageSize: 2 });
    seedReview(service, [pet({ content: '阿明资料一' })], [source()]);
    seedReview(service, [pet({ userid: '44444', content: '阿红资料' })], [source(undefined, { speakerId: '44444' })]);
    seedReview(service, [pet({ content: '阿明资料二' })], [source()]);
    const records = service.reviewRecords(store.pending());
    assert.deepEqual(records.map(record => record.id), ['M000001', 'M000003', 'M000002']);
    const sent = [], e = { self_id: 12345, user_id: 22222, reply: async body => { sent.push(body); return true; } };
    await service.sendReview(e, store.pending(), '待确认');
    assert.match(sent[0], /33333.*本列表 2 项/);
    assert.match(sent[1], /44444.*本列表 1 项/);
    assert.match(sent[1], /3\. M000002/);
    assert.deepEqual(service.planReview(e, '确认 1-2').operations.map(op => op.id), ['M000001', 'M000003']);
});

test('待确认更正显示同人同范围旧记录，不对不同范围或不同对象生成对照', t => {
    const { service, store } = setup(t);
    service.ingest([pet()], [source()]);
    store.manage('确认', 'M000001', '', '22222');
    service.ingest([pet({ content: '豆包其实是白猫', evidence: '豆包其实是白猫', replaces: 'M000001' })], [source('豆包其实是白猫')]);
    const view = service.display(store.data.records[1]);
    assert.match(view, /原记忆 M000001 \[已确认\]/);
    assert.match(view, /本条新说法：豆包其实是白猫/);
    assert.match(view, /确认本条后/);
    assert.equal(store.data.records[0].status, 'confirmed');
    service.ingest([pet({ content: '我的猫豆包只在本群提到', evidence: '我的猫豆包只在本群提到', scope: 'group', replaces: 'M000001' })], [source('我的猫豆包只在本群提到')]);
    assert.doesNotMatch(service.display(store.data.records[2]), /更正对照/);
    service.ingest([pet({ userid: '44444', content: '我的猫也叫豆包', evidence: '我的猫也叫豆包', replaces: 'M000001' })], [source('我的猫也叫豆包', { speakerId: '44444' })]);
    assert.doesNotMatch(service.display(store.data.records[3]), /更正对照/);
});

test('按成员确认只处理当前已展示的该人成员项，新增未展示项和别人不受影响', async t => {
    const h = pluginHarness(t), memory = h.api.memory;
    memory.store.change(data => { data.people['33333'] = { name: '阿明' }; data.people['44444'] = { name: '阿红' }; });
    seedReview(memory, [pet()], [source()]);
    seedReview(memory, [pet({ userid: '44444', content: '阿红的资料' })], [source(undefined, { speakerId: '44444' })]);
    const e = h.event('#memory 待确认', { group_id: undefined, user_id: 22222 });
    await h.instance.memoryCmd(e);
    seedReview(memory, [pet({ content: '列表之后新增的阿明资料' })], [source()]);
    e.msg = '#memory 确认成员 阿明'; await h.instance.memoryCmd(e);
    assert.deepEqual(memory.store.data.records.map(record => record.status), ['confirmed', 'pending', 'pending']);
    e.msg = '#memory 忽略成员 阿红'; await h.instance.memoryCmd(e);
    assert.equal(memory.store.data.records[1].status, 'ignored');
    assert.equal(memory.store.data.records[2].status, 'pending');
});

test('按成员批量确认仍校验展示版本，变化后整批不执行', async t => {
    const { service, store } = setup(t);
    seedReview(service, [pet(), pet({ content: '第二条资料' })], [source()]);
    const e = { self_id: 12345, user_id: 22222, reply: async () => true };
    await service.sendReview(e, store.pending(), '待确认');
    store.change(data => { data.records[1].content = '展示之后修改了'; });
    assert.throws(() => service.planMemberReview(e, '确认', '33333'), /已变化/);
    assert.ok(store.data.records.every(record => record.status === 'pending'));
});

test('本次参考保存的是已发送回复的召回快照，可按固定编号查看当前版本', async t => {
    const h = pluginHarness(t), memory = h.api.memory;
    memory.ingest([pet()], [source()]);
    const e = h.event('#呱瓜 豆包怎么样'); await h.instance.chat(e);
    const trace = memory.lastRecall(e);
    assert.deepEqual(trace.records.map(record => record.id), ['M000001']);
    assert.equal(trace.records[0].status, 'pending');
    memory.store.manage('修正', 'M000001', '豆包是一只白猫', '22222');
    const command = h.event('#memory 本次', { user_id: 22222 }); await h.instance.memoryCmd(command);
    assert.match(String(h.replies.at(-1)), /不表示逐条采用/);
    assert.match(String(h.replies.at(-1)), /橘猫.*豆包/);
    assert.doesNotMatch(String(h.replies.at(-1)), /豆包是一只白猫/);
    command.msg = '#memory 查看 M1'; await h.instance.memoryCmd(command);
    assert.match(String(h.replies.at(-1)), /豆包是一只白猫/);
    assert.equal(h.calls.length, 1);
    assert.doesNotMatch(JSON.stringify(memory.store.history(sessionKey(e), 3)), /reply_format|recalls/);
});

test('资料工具额外提供的记忆也进入本次参考，私聊主人可查看当前机器人的群会话', async t => {
    const h = pluginHarness(t, { p: scopedProfile(), response: (_params, count) => count === 1 ? toolReply('member_profile_query', { action: 'user_info', target: '88888' }) : message('查到啦') });
    h.api.memory.ingest([pet({ userid: '88888' })], [source(undefined, { speakerId: '88888', groupId: '22222' })]);
    const e = h.event('#呱瓜 查询资料'); e.bot.gml = new Map([[99999, new Map([[33333, {}], [88888, {}]])]]);
    await h.instance.chat(e);
    const trace = h.api.memory.lastRecall({ self_id: 12345, user_id: 22222 });
    assert.deepEqual(trace.records.map(record => record.subjectId), ['88888']);
    assert.equal(trace.session, sessionKey(e));
    assert.equal(h.api.memory.lastRecall({ self_id: 54321, user_id: 22222 }), null);
    assert.equal(h.api.memory.lastRecall({ self_id: 12345, group_id: 11111, user_id: 22222 }), null);
});

test('最新一轮没有自动记忆时不会误用上轮参考，未送达回复也不保存参考', async t => {
    const h = pluginHarness(t);
    h.api.memory.ingest([pet()], [source()]);
    const e = h.event('#呱瓜 豆包怎么样'); await h.instance.chat(e);
    h.api.memory.store.manage('忽略', 'M000001');
    const next = h.event('#呱瓜 聊点别的'); await h.instance.chat(next);
    assert.equal(h.api.memory.lastRecall(next).records.length, 0);
    const tracesBefore = h.api.memory.store.data.sessions[sessionKey(e)].recalls.length;
    const failed = h.event('#呱瓜 未送达'); failed.reply = async () => false;
    await h.instance.chat(failed);
    assert.equal(h.api.memory.store.data.sessions[sessionKey(e)].recalls.length, tracesBefore);
});

test('参考快照有保留数量和期限，关闭近期上下文时也不会把快照当对话发给模型', t => {
    const { store, service, advance } = setup(t);
    for (let i = 0; i < 6; i++) store.recordReply('12345:group:11111', { id: `trace-${i}`, history: ['已发送'] }, '问题', 0,
        { userId: '33333', question: `问题${i}`, records: [] });
    assert.equal(store.data.sessions['12345:group:11111'].recalls.length, 4);
    assert.equal(service.lastRecall({ self_id: 12345, group_id: 11111 }).question, '问题5');
    assert.deepEqual(store.history('12345:group:11111', 3), []);
    advance(3 * 86400000 + 1);
    assert.equal(service.lastRecall({ self_id: 12345, group_id: 11111 }), null);
});

test('变化提醒只发新增或版本变化，手动提醒仍展示完整待确认列表', async t => {
    const { service, store, advance } = setup(t);
    store.setConfig({ reminderMode: 'changes', reminderPageSize: 1, reminderInitialDelaySeconds: 0 });
    seedReview(service, [pet(), pet({ content: '另一条资料' })], [source()]);
    const sent = [];
    service.registerBot({ uin: 12345, pickUser: () => ({ sendMsg: async body => { sent.push(body); return true; } }) });
    await service.notifyPending(); assert.equal(sent.length, 2);
    advance(6 * 3600000); await service.notifyPending(); assert.equal(sent.length, 2);
    seedReview(service, [pet({ content: '刚新增的资料' })], [source()]);
    await service.notifyPending(); assert.equal(sent.length, 3);
    assert.match(sent.at(-1), /刚新增的资料/);
    assert.doesNotMatch(sent.at(-1), /另一条资料/);
    store.change(data => { data.records[0].content = '展示过的记录发生变化'; });
    advance(6 * 3600000); await service.notifyPending(); assert.equal(sent.length, 4);
    assert.match(sent.at(-1), /发生变化/);
    await service.notifyPending(true); assert.equal(sent.length, 7);
    assert.equal(store.pending().length, 3);
});

test('变化模式分页失败按原批次续发，已成功页面不重复，进度跨重启保留', async t => {
    const { service, store, root, now, advance } = setup(t);
    store.setConfig({ reminderMode: 'changes', reminderPageSize: 1, reminderInitialDelaySeconds: 0 });
    seedReview(service, [pet({ content: '第1项' }), pet({ content: '第2项' }), pet({ content: '第3项' })], [source()]);
    const sent = []; let fail = true;
    const bot = { uin: 12345, pickUser: () => ({ sendMsg: async body => {
        if (fail && body.includes('第2项')) return false;
        sent.push(body); return { message_id: `page-${sent.length}` };
    } }) };
    service.registerBot(bot); await service.notifyPending(); assert.equal(sent.length, 1);
    const restart = new MemoryService({ directory: root, getProfile: () => profile, logger: quiet, now, complete: async () => message({ memories: [] }) });
    t.after(() => restart.dispose()); restart.registerBot(bot);
    fail = false; advance(300001); await restart.notifyPending();
    assert.equal(sent.length, 3);
    assert.match(sent[1], /2-2\/3/);
    assert.equal(Object.keys(restart.store.data.reminders['22222'].seenVersions).length, 3);
    advance(6 * 3600000); await restart.notifyPending(); assert.equal(sent.length, 3);
});

test('不同主人分别记录已展示版本，提醒模式命令保持主人权限和独立前缀', async t => {
    const { service, store } = setup(t);
    store.setConfig({ reminderMode: 'changes', reminderPageSize: 1, reminderInitialDelaySeconds: 0 });
    service.ingest([pet()], [source()]);
    const sent = [];
    service.registerBot({ uin: 12345, pickUser: uid => ({ sendMsg: async () => { sent.push(uid); return true; } }) });
    await service.notifyPending(); store.setConfig({ masterIds: ['55555'] }); await service.notifyPending();
    assert.deepEqual(sent, ['22222', '55555']);
    const h = pluginHarness(t);
    assert.equal(await h.dispatch(h.event('#memory 提醒模式 变化', { isMaster: false })), 'denied');
    assert.equal(h.api.memory.store.config.reminderMode, 'all');
    await h.dispatch(h.event('#memory 提醒模式 变化'));
    assert.equal(h.api.memory.store.config.reminderMode, 'changes');
    assert.equal(h.calls.length, 0);
});

test('变化提醒续发前原批次被修改时重新列出未收或变化项，不重复已收到的原记录', async t => {
    const { service, store, advance } = setup(t);
    store.setConfig({ reminderMode: 'changes', reminderPageSize: 1, reminderInitialDelaySeconds: 0 });
    seedReview(service, [pet({ content: '已经收到的原记录' }), pet({ content: '尚未收到的原记录' })], [source()]);
    const sent = []; let fail = true;
    service.registerBot({ uin: 12345, pickUser: () => ({ sendMsg: async body => {
        if (fail && body.includes('尚未收到')) return false;
        sent.push(body); return true;
    } }) });
    await service.notifyPending();
    assert.equal(sent.length, 1);
    store.change(data => { data.records[1].content = '修改后的资料'; });
    seedReview(service, [pet({ content: '这期间新增的资料' })], [source()]);
    fail = false; advance(300001); await service.notifyPending();
    assert.equal(sent.length, 3);
    assert.match(sent[1], /1-1\/2/);
    assert.match(sent[1], /修改后的资料/);
    assert.match(sent[2], /这期间新增的资料/);
    assert.doesNotMatch(sent.slice(1).join('\n'), /已经收到的原记录|尚未收到的原记录/);
    assert.equal(Object.keys(store.data.reminders['22222'].seenVersions).length, 3);
});


test('普通回复自动开启引用窗口，原提问者引用实际回复可续聊并在成功回复后续期', async t => {
    const h = quotedHarness(t); let time = Date.now(); h.api.quoteContinuations.now = () => time;
    await h.instance.chat(h.event());
    const firstId = h.sent[0].receipt.message_id;
    assert.equal(typeof h.instance.companionMonitor, 'undefined');
    time += 89999;
    assert.equal(await h.receive(h.follow('再举个例子', firstId)), false);
    assert.equal(h.calls.length, 2);
    time += 89999;
    await h.receive(h.follow('这个例子能再解释一下吗'));
    assert.equal(h.calls.length, 3);
    time += 90000;
    await h.receive(h.follow('超时后的引用'));
    assert.equal(h.calls.length, 3);
});

test('引用续聊只带这段问答，不读取群历史、整个群的会话或摘要，也不获取其他引用正文', async t => {
    let historyReads = 0, quotedReads = 0;
    const h = quotedHarness(t, { config: { 'deepseekJS:historyLength': '3' } });
    await h.instance.chat(h.event('#呱瓜 原提问者的专属问题'));
    h.api.memory.store.appendHistory('12345:group:99999', [{ role: 'user', content: '其他群友的秘密原文' }], 3);
    h.api.memory.store.change(data => { data.sessions['12345:group:99999'].summary = '整个群的聊天摘要'; });
    const e = h.follow('只解释你刚才那句话', undefined, { getReply: async () => { quotedReads++; return { raw_message: '其他人的被引用原文' }; } });
    e.bot.pickGroup = () => ({ getChatHistory: async () => { historyReads++; return [{ raw_message: '群聊近期原文' }]; } });
    await h.receive(e);
    assert.equal(h.calls.length, 2);
    const supplied = JSON.stringify(h.calls[1].messages);
    assert.match(supplied, /原提问者的专属问题/);
    assert.match(supplied, /只解释你刚才那句话/);
    assert.doesNotMatch(supplied, /其他群友的秘密原文|整个群的聊天摘要|其他人的被引用原文|群聊近期原文/);
    assert.equal(historyReads, 0);
    assert.equal(quotedReads, 0);
});

test('其他群、其他机器人和未知消息的引用均不会触发自动续聊', async t => {
    const h = quotedHarness(t);
    await h.instance.chat(h.event());
    const id = h.sent[0].receipt.message_id;
    for (const overrides of [{ group_id: 88888 }, { self_id: 54321 },
        { source: { user_id: 44444 } }, { user_id: 12345 }, { post_type: 'notice' }]) {
        await h.receive(h.follow('不要接这句话', id, overrides));
    }
    await h.receive(h.follow('引用别的机器人', 'other-bot'));
    await h.receive(h.event('呱瓜，你刚才是什么意思？'));
    await h.receive(h.follow('', id));
    assert.equal(h.calls.length, 1);
    assert.equal(h.sent.length, 1);
});

test('带引用的其他插件命令原样放行，不进入模型，不延长续聊窗口', async t => {
    const h = quotedHarness(t); let time = Date.now(); h.api.quoteContinuations.now = () => time;
    await h.instance.chat(h.event());
    const id = h.sent[0].receipt.message_id;
    for (const command of ['#更新面板', '#memory 待确认', '/帮助', '!菜单', '＃更新面板']) {
        const e = h.follow(command, id), original = JSON.stringify({ msg: e.msg, raw: e.raw_message, message: e.message });
        assert.equal(await h.instance.accept(e), false);
        assert.equal(JSON.stringify({ msg: e.msg, raw: e.raw_message, message: e.message }), original);
        if (command === '#memory 待确认') assert.equal(await h.dispatch(e), 'memoryCmd');
        else {
            const handled = [];
            const result = await h.dispatch(e, [{ reg: /^(?:#更新面板|\/帮助|!菜单|＃更新面板)$/,
                run: async message => { handled.push(message.msg); return true; } }]);
            assert.equal(result, 'other-plugin');
            assert.deepEqual(handled, [command]);
        }
    }
    await turn();
    assert.equal(h.calls.length, 1);
    time += 90000;
    await h.receive(h.follow('命令没有续期', id));
    assert.equal(h.calls.length, 1);
});

test('普通群聊和引用其他人的消息不会因此进入模型或记忆提取', async t => {
    const extracted = [];
    const h = quotedHarness(t, { extraction: params => {
        extracted.push(...JSON.parse(params.messages[1].content).messages.map(item => item.text));
        return message({ memories: [] });
    } });
    await h.instance.chat(h.event('#呱瓜 这是正常提问')); await turn();
    for (const e of [h.event('群友之间讨论秘密消息', { user_id: 44444 }), h.follow('引用其他人的秘密消息', 'someone-else')]) await h.receive(e);
    await h.api.memory.processExtractions();
    assert.equal(h.calls.length, 1);
    assert.ok(extracted.includes('这是正常提问'));
    assert.doesNotMatch(JSON.stringify(extracted), /秘密消息/);
    assert.doesNotMatch(JSON.stringify(h.api.memory.store.data.observations), /秘密消息/);
});

test('等待续聊模型时入口立即放行，重复投递不会多次生成，期间其他命令仍可处理', async t => {
    const started = deferred(), finish = deferred();
    const h = quotedHarness(t, { response: (_, count) => count === 1 ? message('初次回复') : (started.resolve(), finish.promise) });
    await h.instance.chat(h.event());
    const e = h.follow('继续解释');
    assert.equal(await h.instance.accept(e), false);
    await started.promise;
    assert.equal(await h.instance.accept(e), false);
    const redelivered = h.follow('继续解释', e.reply_id, { message_id: e.message_id });
    assert.equal(await h.instance.accept(redelivered), false);
    const command = h.follow('#更新面板', e.reply_id);
    assert.equal(await h.instance.accept(command), false);
    assert.equal(command.msg, '#更新面板');
    const running = h.api.memory.chains.get(sessionKey(e));
    finish.resolve(message('续聊回复')); await running;
    assert.equal(h.calls.length, 2);
    assert.equal(h.sent.length, 2);
});

test('重置或成员资格失效会撤销旧引用窗口，并取消正在生成的续聊回复', async t => {
    const started = deferred(), finish = deferred();
    const h = quotedHarness(t, { response: (_, count) => count === 1 ? message('初次回复') : (started.resolve(), finish.promise) });
    await h.instance.chat(h.event());
    const e = h.follow('等待期间被重置');
    await h.instance.accept(e); await started.promise;
    const running = h.api.memory.chains.get(sessionKey(e));
    await h.instance.reset(h.event('#结束对话'));
    finish.resolve(message('不应发出的旧续聊')); await running;
    assert.doesNotMatch(JSON.stringify(h.sent), /不应发出的旧续聊/);
    await h.receive(h.follow('重置之后仍引用旧回答', e.reply_id));
    assert.equal(h.calls.length, 2);
    await h.instance.chat(h.event('#呱瓜 新话题'));
    const id = h.sent.at(-1).receipt.message_id;
    h.api.memory.invalidate(e);
    await h.receive(h.follow('资格已经失效', id));
    assert.equal(h.calls.length, 3);
});

test('成功回执没有消息编号时不开窗口，分次回复的各条编号都可引用，内部引用标记不进入原话', async t => {
    const missing = pluginHarness(t);
    await missing.instance.chat(missing.event());
    assert.equal(missing.api.quoteContinuations.windows.size, 0);
    const h = quotedHarness(t, { response: () => message(bubbles('第一段回答', '第二段回答')) });
    await h.instance.chat(h.event());
    const ids = h.sent.map(item => item.receipt.message_id);
    for (const id of ids) await h.receive(h.follow('继续讲', id));
    assert.equal(h.calls.length, 3);
    assert.doesNotMatch(h.calls[1].messages.at(-1).content, /\[回复消息\]|CQ:reply/);
    assert.match(h.calls[1].messages.at(-1).content, /引用消息（呱瓜 发的）.*第一段回答/s);
});

test('关闭上下文时引用续聊仍可使用当前引用，新的明确提问保留独立窗口', async t => {
    const h = quotedHarness(t, { config: { 'deepseekJS:maxLength': '0' } });
    await h.instance.chat(h.event('#呱瓜 旧话题的原问题'));
    const oldId = h.sent[0].receipt.message_id;
    await h.receive(h.follow('看一下当前引用', oldId));
    assert.equal(h.calls.length, 2);
    assert.doesNotMatch(JSON.stringify(h.calls[1].messages), /旧话题的原问题/);
    assert.match(h.calls[1].messages.at(-1).content, /引用消息（呱瓜 发的）/);
    await h.instance.chat(h.event('#呱瓜 新话题'));
    await h.receive(h.follow('仍可引用旧话题', oldId));
    assert.equal(h.calls.length, 4);
    assert.doesNotMatch(h.calls[3].messages.at(-1).content, /新话题/);
    assert.equal(h.api.memory.store.history('12345:group:99999', 3).length, 0);
});

test('引用记录来自适配器消息段或来源编号时也可识别，私聊及卸载后不续聊', async t => {
    const h = quotedHarness(t);
    await h.instance.chat(h.event());
    const id = h.sent[0].receipt.message_id;
    const e = h.follow('仅消息段有引用', id, { reply_id: undefined });
    await h.receive(e);
    assert.equal(h.calls.length, 2);
    await h.receive(h.event('仅来源对象有引用', { source: { message_id: id, user_id: 12345 } }));
    assert.equal(h.calls.length, 3);
    await h.receive(h.follow('私聊不自动接', id, { group_id: undefined }));
    h.api.memory.dispose();
    await h.receive(h.follow('插件卸载后不接', id));
    assert.equal(h.calls.length, 3);
});

test('热更新会停止旧定时器和续发任务，不遗留主动发言状态', async t => {
    const timer = { oldInterval: true }, retry = { oldTimeout: true };
    const state = { enabled: true, pendingReply: { oldReply: true }, retryTimer: retry, buffer: ['旧群聊原文'] };
    const h = pluginHarness(t, { globals: { __deepseekCompanionTimerHandle: timer,
        __deepseekCompanionState: new Map([['12345:group:99999', state]]) } });
    assert.equal(state.enabled, false);
    assert.equal(state.pendingReply, null);
    assert.equal(state.buffer.length, 0);
    assert.ok(h.clearedIntervals.includes(timer));
    assert.ok(h.clearedTimeouts.includes(retry));
    assert.equal(h.sandbox.__deepseekCompanionTimerHandle, undefined);
    assert.equal(h.sandbox.__deepseekCompanionState, undefined);
    assert.equal(h.calls.length, 0);
    assert.equal(h.replies.length, 0);
});

test('旧监听缓冲及对应待提取原文停用，v2和v3均保留记忆历史快照和提醒', t => {
    for (const version of [2, 3]) {
        const { root, store, service } = setup(t);
        service.ingest([pet()], [source()]);
        store.manage('确认', 'M000001');
        store.appendHistory('12345:group:99999', [{ role: 'user', content: '正常提问' }, { role: 'assistant', content: '正常回答' }], 3);
        store.change(data => {
            data.sessions['12345:group:99999'].companion = { buffer: [{ source: { id: 'old-watched' }, content: '旧监听的群聊' }] };
            data.observations = [source('旧监听的群聊', { id: 'old-watched' }), source('主动提问', { id: 'direct' })];
            data.reminders = { '22222': { lastSentAt: 123, nextPage: 1 } };
            data.sessions['12345:group:99999'].recalls = [{ id: 'saved-reference', at: 123, records: [] }];
        });
        const original = JSON.parse(fs.readFileSync(store.file, 'utf8'));
        if (version === 2) {
            original.version = 2; original.members = original.people; delete original.people;
            fs.writeFileSync(store.file, JSON.stringify(original, null, 2));
        }
        const bytes = fs.readFileSync(store.file, 'utf8');
        const reopened = new MemoryStore(root, { logger: quiet });
        assert.equal(fs.readFileSync(store.file, 'utf8'), bytes, '读取升级不立即改写原文件');
        assert.equal('companion' in reopened.data.sessions['12345:group:99999'], false);
        assert.deepEqual(reopened.data.observations.map(item => item.id), ['direct']);
        assert.deepEqual(reopened.data.records, original.records);
        assert.deepEqual(reopened.data.sessions['12345:group:99999'].history, original.sessions['12345:group:99999'].history);
        assert.deepEqual(reopened.data.sessions['12345:group:99999'].recalls, original.sessions['12345:group:99999'].recalls);
        assert.deepEqual(reopened.data.reminders, original.reminders);
        reopened.change(() => {});
        const written = JSON.parse(fs.readFileSync(store.file, 'utf8'));
        assert.equal('companion' in written.sessions['12345:group:99999'], false);
        assert.deepEqual(written.observations.map(item => item.id), ['direct']);
    }
});

test('旧陪伴命令不再被本插件接管，其他插件可继续使用同名命令', async t => {
    const h = quotedHarness(t);
    await h.instance.chat(h.event());
    for (const command of ['#陪伴', '#陪伴关闭', '#开启陪伴', '#呱瓜陪伴 开启']) {
        const handled = [], e = h.follow(command);
        const result = await h.dispatch(e, [{ reg: /^#(?:陪伴.*|开启陪伴|呱瓜陪伴 开启)$/,
            run: async event => { handled.push(event.msg); return true; } }]);
        assert.equal(result, 'other-plugin');
        assert.deepEqual(handled, [command]);
    }
    assert.equal(h.calls.length, 1);
});

test('仅保留的引用续聊仍按当前群资格处理模型资料查询，参数不能引入外群成员', async t => {
    const h = quotedHarness(t, { p: scopedProfile(), response: (_, count) => count === 2
        ? toolReply('member_profile_query', { action: 'user_info', target: '55555', groupId: '22222', memberIds: ['55555'] })
        : message('本群查不到该成员') });
    const e = h.event('#呱瓜 当前群的话题', { group_id: 11111 });
    e.bot.gml = new Map([[11111, new Map([[33333, {}]])]]);
    await h.instance.chat(e);
    await h.receive(h.follow('去其他群查55555', undefined, { group_id: 11111 }));
    assert.equal(h.calls.length, 3);
    assert.doesNotMatch(h.calls[2].messages.at(-1).content, /userid=55555|生日:2月2日|乙群成员/);
});

test('其他群友可引用接话，当前发言人、历史回应对象和宠物记忆的来源分别保留', async t => {
    const captured = [], facts = {
        '33333': { evidence: '我的橘猫叫豆包', name: '豆包' },
        '44444': { evidence: '我的白猫叫元宝', name: '元宝' }
    };
    const h = quotedHarness(t, { extraction: params => {
        const sources = JSON.parse(params.messages[1].content).messages;
        captured.push(...sources);
        return message({ memories: sources.filter(item => facts[item.speakerId] && item.text.includes(facts[item.speakerId].evidence)).map(item =>
            pet({ userid: item.speakerId, source_id: item.id, evidence: facts[item.speakerId].evidence,
                content: `养了一只叫${facts[item.speakerId].name}的猫`, entity: { name: facts[item.speakerId].name, kind: '猫', relation: '宠物' } })) });
    } });
    await h.instance.chat(h.event('#呱瓜 我的橘猫叫豆包', { sender: { card: '甲', nickname: '甲' } }));
    const firstId = h.sent[0].receipt.message_id;
    const second = h.follow('我的白猫叫元宝', firstId, { user_id: 44444, sender: { card: '乙', nickname: '乙' } });
    await h.receive(second);
    assert.equal(h.calls.length, 2);
    assert.match(h.calls[1].messages[0].content, /当前新消息的发言人：userid=44444/);
    assert.match(h.calls[1].messages[0].content, /被引用回答当时回应的成员：userid=33333/);
    assert.match(h.calls[1].messages.at(-1).content, /userid:44444[\s\S]*群昵称:乙[\s\S]*我的白猫叫元宝/);
    assert.match(h.calls[1].messages[0].content, /"reply_to_userid":"33333"/);
    assert.ok(h.calls[1].messages.filter(m => m.role === 'assistant').every(m => !m.content.includes('机器人回应的发言人')));
    const secondId = h.sent.at(-1).receipt.message_id;
    await h.receive(h.follow('刚才的猫分别是谁的？', secondId, { user_id: 55555, sender: { card: '丙', nickname: '丙' } }));
    assert.equal(h.calls.length, 3);
    assert.match(h.calls[2].messages[0].content, /当前新消息的发言人：userid=55555/);
    assert.match(h.calls[2].messages[0].content, /被引用回答当时回应的成员：userid=44444/);
    assert.match(h.calls[2].messages[0].content, /"reply_to_userid":"33333"/);
    assert.match(h.calls[2].messages[0].content, /"reply_to_userid":"44444"/);
    await h.api.memory.processExtractions();
    assert.equal(captured.find(item => item.text === '我的白猫叫元宝').speakerId, '44444');
    assert.deepEqual(h.api.memory.store.data.records.map(record => [record.subjectId, record.entity.name]),
        [['33333', '豆包'], ['44444', '元宝']]);
    assert.equal(h.api.memory.lastRecall(second).userId, '55555');
});

test('同群多人独立发起的话题都可被第三人引用，各自只带本话题问答', async t => {
    const h = quotedHarness(t);
    await h.instance.chat(h.event('#呱瓜 甲的独立项目话题'));
    const firstId = h.sent.at(-1).receipt.message_id;
    await h.instance.chat(h.event('#呱瓜 乙的另一个独立话题', { user_id: 44444 }));
    const secondId = h.sent.at(-1).receipt.message_id;
    await h.receive(h.follow('接着谈甲的话题', firstId, { user_id: 55555 }));
    assert.equal(h.calls.length, 3);
    assert.match(JSON.stringify(h.calls[2].messages), /甲的独立项目话题/);
    assert.doesNotMatch(JSON.stringify(h.calls[2].messages), /乙的另一个独立话题/);
    await h.receive(h.follow('再谈乙的话题', secondId, { user_id: 55555 }));
    assert.equal(h.calls.length, 4);
    assert.match(JSON.stringify(h.calls[3].messages), /乙的另一个独立话题/);
    assert.doesNotMatch(JSON.stringify(h.calls[3].messages), /甲的独立项目话题|接着谈甲的话题/);
});

test('各话题独立过期，其他成员接话仅为被引用的话题续期，关闭上下文也标注引用对象', async t => {
    const h = quotedHarness(t, { config: { 'deepseekJS:maxLength': '0' } });
    let now = Date.now(); h.api.quoteContinuations.now = () => now;
    await h.instance.chat(h.event('#呱瓜 甲的话题'));
    const firstId = h.sent.at(-1).receipt.message_id;
    now += 30000;
    await h.instance.chat(h.event('#呱瓜 乙的话题', { user_id: 44444 }));
    const secondId = h.sent.at(-1).receipt.message_id;
    now += 30000;
    await h.receive(h.follow('丙接甲的话题', firstId, { user_id: 55555 }));
    assert.equal(h.calls.length, 3);
    assert.match(h.calls[2].messages[0].content, /当前新消息的发言人：userid=55555/);
    assert.match(h.calls[2].messages[0].content, /被引用回答当时回应的成员：userid=33333/);
    now += 60000;
    await h.receive(h.follow('乙的话题已经过期', secondId, { user_id: 55555 }));
    assert.equal(h.calls.length, 3);
    await h.receive(h.follow('甲的话题仍可接', firstId, { user_id: 44444 }));
    assert.equal(h.calls.length, 4);
});

test('昵称和普通群聊不能自行启动判断，平时消息不进入模型或记忆', async t => {
    const clock = new FakeClock(), h = quotedHarness(t, { listeningClock: clock });
    for (const text of ['呱瓜', '笨瓜', '大笨瓜说话', '你在吗', '为什么你这么麻烦']) {
        assert.equal(await h.instance.accept(h.event(text)), false);
    }
    await clock.advance(70000);
    assert.equal(h.judgments.length, 0);
    assert.equal(h.calls.length, 0);
    assert.equal(h.sent.length, 0);
    assert.equal(h.api.memory.store.data.observations.length, 0);
    assert.equal(h.api.conversationListening.sessions.size, 0);
});

test('空呱瓜统一判断后按完整人设回答，不再有两秒固定问候', async t => {
    const clock = new FakeClock();
    const h = quotedHarness(t, { listeningClock: clock, config: { 'deepseekJS:thinking_enabled': 'true' },
        pluginConfig: { persona: { systemPrompt: '保持自然、友善、有辨识度的群聊语气。测试人设甲。' } },
        judgment: params => {
            const input = JSON.parse(params.messages[1].content);
            assert.equal(input.entry, 'command');
            return message({ action: 'reply', message_ids: input.messages.map(item => item.id), target_id: '33333' });
        }, response: () => message('哎呀，我在这儿呢～') });
    assert.equal(await h.dispatch(h.event('#呱瓜')), 'chat');
    await clock.advance(2000);
    assert.equal(h.sent.length, 0); assert.equal(h.calls.length, 0); assert.equal(h.judgments.length, 0);
    await clock.advance(6000);
    assert.equal(h.judgments.length, 1); assert.equal(h.calls.length, 1);
    assert.equal(h.judgments[0].thinking.type, 'disabled');
    assert.equal(h.judgments[0].max_tokens, 768);
    assert.equal(h.judgments[0].tools, undefined);
    assert.equal(h.sent[0].payload.join(''), '哎呀，我在这儿呢～');
    assert.match(h.calls[0].messages[0].content, /保持自然、友善、有辨识度的群聊语气/);
    assert.equal(h.api.conversationListening.sessions.size, 1);
    await clock.advance(60000);
    assert.equal(h.api.conversationListening.sessions.size, 0);
});

test('普通明确提问后无关键词也能续聊，静默前文供理解但不当作新自述提取', async t => {
    const clock = new FakeClock(), extracted = [];
    const h = quotedHarness(t, { listeningClock: clock, config: { 'deepseekJS:maxLength': '3' },
        judgment: (params, count) => {
            const input = JSON.parse(params.messages[1].content);
            if (count === 1) return message({ action: 'silent' });
            const complaint = input.previous_messages.find(item => item.text === '为什么你这么麻烦');
            assert.ok(complaint);
            assert.ok(input.context.some(item => item.role === 'assistant'));
            return message({ action: 'reply', message_ids: [input.messages.at(-1).id], context_message_ids: [complaint.id], target_id: '33333' });
        }, extraction: params => { extracted.push(...JSON.parse(params.messages[1].content).messages); return message({ memories: [] }); }
    });
    await h.instance.chat(h.event('#呱瓜 先聊一会'));
    assert.equal(h.calls.length, 1); assert.equal(h.judgments.length, 0);
    await h.instance.accept(h.event('为什么你这么麻烦'));
    await clock.advance(8000);
    assert.equal(h.calls.length, 1);
    await h.instance.accept(h.event('你倒是说话呀'));
    await clock.advance(8000);
    assert.equal(h.calls.length, 2);
    const supplied = h.calls[1].messages.at(-1).content;
    assert.match(supplied, /本话题相关前文[\s\S]*为什么你这么麻烦[\s\S]*本轮需要回应的新消息[\s\S]*你倒是说话呀/);
    await h.api.memory.processExtractions();
    assert.ok(extracted.some(item => item.text === '你倒是说话呀'));
    assert.equal(extracted.filter(item => item.text === '为什么你这么麻烦').length, 1);
    assert.doesNotMatch(JSON.stringify(h.sent), /怎么啦|我在听哦/);
});

test('同批只回答最后一句时相关前文仍送入回答，不把前文当成选中的新消息', async t => {
    const clock = new FakeClock(), extracted = [];
    const h = quotedHarness(t, { listeningClock: clock, judgment: params => {
        const batch = JSON.parse(params.messages[1].content).messages;
        return message({ action: 'reply', message_ids: [batch.at(-1).id], context_message_ids: [batch.find(item => item.text === '为什么你这么麻烦').id] });
    }, extraction: params => { extracted.push(...JSON.parse(params.messages[1].content).messages); return message({ memories: [] }); } });
    await h.dispatch(h.event('#呱瓜'));
    await h.instance.accept(h.event('为什么你这么麻烦'));
    await h.instance.accept(h.event('你说话呀'));
    await clock.advance(12000);
    assert.equal(h.calls.length, 1);
    assert.match(h.calls[0].messages.at(-1).content, /为什么你这么麻烦[\s\S]*你说话呀/);
    await h.api.memory.processExtractions();
    assert.deepEqual(extracted.map(item => item.text), ['为什么你这么麻烦', '你说话呀']);
});

test('限时收集仅含参与者，八四二秒后一次判断，不读取整个群历史', async t => {
    const clock = new FakeClock(), extracted = [];
    const h = quotedHarness(t, { listeningClock: clock, config: { 'deepseekJS:historyLength': '3' },
        judgment: params => {
            const batch = JSON.parse(params.messages[1].content).messages;
            return message({ action: 'reply', message_ids: batch.filter(item => item.text.includes('我的猫')).map(item => item.id),
                memory_message_ids: batch.filter(item => /我的猫(?:叫|还喜欢)/.test(item.text)).map(item => item.id), target_id: '33333' });
        }, extraction: params => { extracted.push(...JSON.parse(params.messages[1].content).messages); return message({ memories: [] }); } });
    await h.dispatch(h.event('#呱瓜'));
    await clock.advance(1000);
    await h.instance.accept(h.event('我的猫叫豆包'));
    await h.instance.accept(h.event('笨瓜，这是其他人的普通群聊', { user_id: 44444 }));
    await h.dispatch(h.event('#更新面板'), [{ reg: /^#更新面板$/, run: async () => true }]);
    await clock.advance(7000);
    assert.equal(h.judgments.length, 0);
    await clock.advance(1000);
    const second = h.event('我的猫还喜欢晒太阳');
    let historyReads = 0;
    second.bot.pickGroup = () => ({ getChatHistory: async () => { historyReads++; return [{ raw_message: '不应读取的群历史' }]; } });
    await h.instance.accept(second);
    await clock.advance(3000);
    await h.instance.accept(h.event('我的猫的问题补充完了'));
    await clock.advance(2000);
    assert.equal(h.judgments.length, 1); assert.equal(h.calls.length, 1);
    assert.equal(historyReads, 0);
    assert.doesNotMatch(JSON.stringify(h.judgments), /其他人的普通群聊|更新面板/);
    assert.doesNotMatch(JSON.stringify(h.calls), /其他人的普通群聊|不应读取的群历史/);
    assert.ok(extracted.every(source => source.speakerId === '33333'));
    assert.ok(extracted.some(source => source.text === '我的猫叫豆包'));
});

test('等待始终静默，无新内容不再判断，结束意图关闭限时话题', async t => {
    const clock = new FakeClock();
    const h = quotedHarness(t, { listeningClock: clock, judgment: (_params, count) => message({ action: count === 1 ? 'wait' : 'end' }) });
    await h.dispatch(h.event('#呱瓜'));
    await clock.advance(20000);
    assert.equal(h.judgments.length, 1); assert.equal(h.sent.length, 0);
    await h.instance.accept(h.event('算了，不聊了'));
    await clock.advance(8000);
    assert.equal(h.judgments.length, 2); assert.equal(h.calls.length, 0);
    assert.equal(h.api.conversationListening.sessions.size, 0);
    assert.equal(h.api.memory.store.data.observations.length, 0);
    await h.instance.accept(h.event('这条已经回到普通群聊'));
    await clock.advance(70000);
    assert.equal(h.judgments.length, 2);
});

test('其他成员有效引用可加入收集，前后发言保留各自身份和记忆来源', async t => {
    const clock = new FakeClock(), sources = [];
    const h = quotedHarness(t, { listeningClock: clock, judgment: params => {
        const batch = JSON.parse(params.messages[1].content).messages.filter(item => item.text.includes('我养'));
        return message({ action: 'reply', message_ids: batch.map(item => item.id), memory_message_ids: batch.map(item => item.id), target_id: '44444' });
    }, extraction: params => { sources.push(...JSON.parse(params.messages[1].content).messages); return message({ memories: [] }); } });
    await h.instance.chat(h.event('#呱瓜 先聊宠物'));
    const replyId = h.sent[0].receipt.message_id;
    await h.instance.accept(h.event('我养了一只橘猫', { sender: { card: '甲', nickname: '甲' } }));
    await h.instance.accept(h.follow('我养了一只白猫', replyId, { user_id: 44444, sender: { card: '乙', nickname: '乙' } }));
    await clock.advance(12000);
    assert.equal(h.judgments.length, 1); assert.equal(h.calls.length, 2);
    const supplied = h.calls[1].messages.at(-1).content;
    assert.match(supplied, /userid:44444[\s\S]*群昵称:乙[\s\S]*我养了一只白猫/);
    assert.match(supplied, /userid:33333[\s\S]*群昵称:甲[\s\S]*我养了一只橘猫/);
    await h.api.memory.processExtractions();
    assert.deepEqual(sources.filter(item => item.text.startsWith('我养')).map(item => [item.speakerId, item.text]), [['33333', '我养了一只橘猫'], ['44444', '我养了一只白猫']]);
    assert.equal(h.api.memory.lastRecall(h.event()).userId, '44444');
});

test('重置会取消判断或正式生成，迟到回答不得发送', async t => {
    for (const phase of ['judge', 'reply']) {
        const clock = new FakeClock(), started = deferred(), finish = deferred();
        const h = quotedHarness(t, { listeningClock: clock,
            judgment: params => {
                if (phase === 'judge') { started.resolve(); return finish.promise; }
                return message({ action: 'reply', message_ids: [JSON.parse(params.messages[1].content).messages[0].id] });
            }, response: () => { started.resolve(); return finish.promise; } });
        await h.dispatch(h.event('#呱瓜'));
        const pending = clock.advance(8000); await started.promise;
        await h.instance.reset(h.event('#结束对话'));
        finish.resolve(message({ action: 'silent' })); await pending;
        assert.doesNotMatch(JSON.stringify(h.sent), /正常回复|我在听哦/);
        assert.equal(h.api.conversationListening.sessions.size, 0);
        assert.equal(clock.timers.size, 0);
    }
});

test('生成期间收到新补充时旧回答不发送，合并重判后可明确结束', async t => {
    const clock = new FakeClock(), started = deferred(), finish = deferred();
    const h = quotedHarness(t, { listeningClock: clock,
        judgment: (params, count) => count === 1
            ? message({ action: 'reply', message_ids: JSON.parse(params.messages[1].content).messages.map(item => item.id) })
            : message({ action: 'end' }),
        response: () => { started.resolve(); return finish.promise; } });
    await h.dispatch(h.event('#呱瓜'));
    const pending = clock.advance(8000); await started.promise;
    await h.instance.accept(h.event('算了，不用回答了'));
    finish.resolve(message('不应出现的旧回答')); await pending;
    assert.equal(h.sent.length, 0);
    await clock.advance(8000);
    assert.equal(h.judgments.length, 2);
    assert.equal(h.api.conversationListening.sessions.size, 0);
});

test('限时接话不阻塞其他插件命令，错误编号不重试，私聊不进入收集', async t => {
    const clock = new FakeClock();
    const h = quotedHarness(t, { listeningClock: clock, judgment: () => message({ action: 'reply', message_ids: ['other-message'] }) });
    await h.instance.chat(h.event('#呱瓜 开始'));
    await h.instance.accept(h.event('接着说'));
    const handled = [];
    for (const text of ['#更新面板', '/帮助', '!菜单']) {
        assert.equal(await h.dispatch(h.event(text), [{ reg: /^(?:#更新面板|\/帮助|!菜单)$/, run: async e => { handled.push(e.msg); return true; } }]), 'other-plugin');
    }
    assert.deepEqual(handled, ['#更新面板', '/帮助', '!菜单']);
    await h.instance.accept(h.event('私聊不能进入群收集', { group_id: undefined }));
    await clock.advance(70000);
    assert.equal(h.judgments.length, 1); assert.equal(h.calls.length, 1);
    assert.equal(h.api.conversationListening.sessions.size, 0);
});

test('六十秒注意窗口结束后普通消息不入模，九十秒内有效引用仍可续聊', async t => {
    const clock = new FakeClock(), h = quotedHarness(t, { listeningClock: clock });
    h.api.quoteContinuations.now = clock.now;
    await h.instance.chat(h.event('#呱瓜 先前问题'));
    await clock.advance(60001);
    assert.equal(h.api.conversationListening.sessions.size, 0);
    await h.instance.accept(h.event('笨瓜你还在吗'));
    await clock.advance(8000);
    assert.equal(h.judgments.length, 0); assert.equal(h.calls.length, 1);
    await h.receive(h.follow('你再详细解释一下', undefined, { user_id: 44444 }));
    assert.equal(h.calls.length, 2);
    assert.equal(h.api.conversationListening.sessions.size, 1);
});

test('适配器没有引用编号时本人限时接话仍保留上下文，伪造前文编号被拒绝', async t => {
    const clock = new FakeClock();
    const h = pluginHarness(t, { listeningClock: clock, config: { 'deepseekJS:maxLength': '3' }, judgment: (params, count) => {
        const input = JSON.parse(params.messages[1].content);
        assert.ok(input.context.some(item => item.role === 'assistant'));
        return message({ action: 'reply', message_ids: input.messages.map(item => item.id), context_message_ids: count === 1 ? [] : ['foreign-topic-id'] });
    } });
    await h.instance.chat(h.event('#呱瓜 先前内容'));
    assert.equal(h.api.quoteContinuations.windows.size, 0);
    await h.instance.accept(h.event('这是无关键词的后续'));
    await clock.advance(8000);
    assert.equal(h.judgments.length, 1); assert.equal(h.calls.length, 2);
    assert.match(JSON.stringify(h.calls[1].messages), /先前内容/);
    await h.instance.accept(h.event('这次判断返回伪造编号'));
    await clock.advance(8000);
    assert.equal(h.judgments.length, 2); assert.equal(h.calls.length, 2);
    assert.equal(h.api.conversationListening.sessions.size, 0);
});

test('关闭近期上下文后限时判断不附加已处理前文，但本轮补充仍可使用', async t => {
    const clock = new FakeClock();
    const h = quotedHarness(t, { listeningClock: clock, config: { 'deepseekJS:maxLength': '0' },
        judgment: (params, count) => {
            const input = JSON.parse(params.messages[1].content);
            assert.deepEqual(input.context, []);
            assert.deepEqual(input.previous_messages, []);
            return count === 1 ? message({ action: 'silent' }) : message({ action: 'reply', message_ids: input.messages.map(item => item.id) });
        } });
    await h.instance.chat(h.event('#呱瓜 已结束的独特旧内容'));
    await h.instance.accept(h.event('上一批不应再附加的独特原文'));
    await clock.advance(8000);
    await h.instance.accept(h.event('本轮需要回应的新补充'));
    await clock.advance(8000);
    assert.equal(h.calls.length, 2);
    assert.doesNotMatch(JSON.stringify(h.calls[1].messages), /已结束的独特旧内容|上一批不应再附加的独特原文/);
    assert.match(JSON.stringify(h.calls[1].messages), /本轮需要回应的新补充/);
});

test('普通聊天、引用与统一接话共用原人设，自然收尾和分段正文原样发送', async t => {
    const clock = new FakeClock();
    const replies = [
        ['哎呀，又被你逮到了～(￣▽￣)', '这点小心思都藏不住啦。'],
        ['就让你得意这一回～'],
        ['笨瓜在这儿呢～', '这回可没躲着你。']
    ];
    const h = quotedHarness(t, { listeningClock: clock, config: { 'deepseekJS:maxLength': '3' },
        pluginConfig: { persona: { systemPrompt: '保持自然、友善、有辨识度的群聊语气。测试人设乙。' } },
        judgment: params => message({ action: 'reply', message_ids: JSON.parse(params.messages[1].content).messages.map(item => item.id), target_id: '33333' }),
        response: (_params, count) => message({ reply_format: 'guagua-v1', mode: 'chat', messages: replies[count - 1] })
    });
    await h.instance.chat(h.event('#呱瓜 你是不是又在偷偷乐'));
    await h.receive(h.follow('果然被我发现了'));
    await h.instance.accept(h.event('你又藏起来啦'));
    await clock.advance(8000);
    assert.equal(h.calls.length, 3);
    assert.deepEqual(h.sent.map(item => item.payload.join('')), replies.flat());
    for (const params of h.calls) {
        const system = params.messages[0].content;
        assert.match(system, /保持自然、友善、有辨识度的群聊语气/);
        assert.match(system, /沿用当前人设、语气和对话氛围表达/);
        assert.match(system, /分段只标记自然说话的停顿/);
        assert.doesNotMatch(system, /通常1～3条|问题解答时除外|在正经问题时切换正式语气/);
    }
    const window = [...h.api.quoteContinuations.windows.values()].at(-1);
    assert.ok(window.history.filter(item => item.role === 'assistant').at(-1).content.endsWith(replies[2].join('\n\n')));
});

test('旧的多段回答迟到时不重开收集或覆盖后来明确提问的话题', async t => {
    const paused = deferred(), release = deferred();
    let stopped = false;
    const h = quotedHarness(t, {
        response: (_params, count) => count === 1
            ? message({ reply_format: 'guagua-v1', mode: 'chat', messages: ['旧第一段', '旧第二段', '旧第三段'] })
            : message('新话题的回答'),
        pause: async () => { if (!stopped) { stopped = true; paused.resolve(); await release.promise; } }
    });
    const first = h.instance.chat(h.event('#呱瓜 第一个话题'));
    await paused.promise;
    const e = h.event('#呱瓜 后来明确提出的新话题');
    const second = h.instance.chat(e);
    const current = h.api.conversationListening.byUser(sessionKey(e), e.user_id);
    release.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(h.sent.map(item => item.payload.join('')), ['旧第一段', '新话题的回答']);
    assert.equal(h.api.conversationListening.sessions.size, 1);
    assert.equal(h.api.conversationListening.byUser(sessionKey(e), e.user_id), current);
    assert.equal(current.root.eventId, e.message_id);
    assert.doesNotMatch(JSON.stringify(current.history), /旧第一段|旧第二段|旧第三段/);
});

test('引用动图只发呱瓜也直接识图，不进入空呼叫收集或发送问候', async t => {
    const clock = new FakeClock(), gif = tinyGif();
    let reads = 0, decoded = 0;
    const h = pluginHarness(t, { listeningClock: clock,
        judgment: params => message({ action: 'reply', message_ids: JSON.parse(params.messages[1].content).messages.map(item => item.id) }),
        http: { get: async () => ({ data: gif, headers: { 'content-type': 'image/gif' } }) } });
    h.api.gifVision.decoder = async (_bytes, selected, cell) => { decoded++; return rgbaFrames(selected, cell); };
    const e = h.event('#呱瓜', { reply_id: 'quoted-gif',
        message: [{ type: 'reply', id: 'quoted-gif' }, { type: 'text', text: '#呱瓜' }],
        getReply: async () => { reads++; return { sender: { nickname: '原发图人' }, message: [{ type: 'image', url: 'https://example.com/quoted-gif' }] }; } });
    assert.equal(await h.dispatch(e), 'chat');
    assert.equal(h.calls.length, 1);
    assert.equal(h.judgments.length, 0);
    assert.equal(reads, 1); assert.equal(decoded, 1);
    const content = h.calls[0].messages.at(-1).content;
    assert.ok(Array.isArray(content));
    assert.match(content.find(part => part.type === 'image_url').image_url.url, /^data:image\/png;base64,/);
    assert.ok(content.some(part => part.type === 'text' && part.text.includes('6个采样帧')));
    assert.match(content[0].text, /引用.*图片/);
    assert.doesNotMatch(content[0].text, /仅发送了#呱瓜触发对话，没有补充具体聊天内容|\[回复消息\]/);
    await clock.advance(14000);
    assert.equal(h.judgments.length, 0);
    assert.equal(h.api.memory.store.data.observations.length, 0);
});

test('普通图片引用兼容reply段、source和reply_to，群聊私聊均不当作空招呼', async t => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXS8AAAAASUVORK5CYII=', 'base64');
    for (const overrides of [
        { message: [{ type: 'reply', id: 'photo' }, { type: 'text', text: '#呱瓜' }] },
        { source: { message_id: 'photo', user_id: 44444 } },
        { reply_to: { id: 'photo', user_id: 44444 } },
        { reply_id: 'photo', message: [], raw_message: '[CQ:reply,id=photo]#呱瓜' },
        { reply_id: 'photo', group_id: undefined, group: undefined }
    ]) {
        const h = pluginHarness(t, { http: { get: async () => ({ data: png, headers: { 'content-type': 'image/png' } }) } });
        h.api.gifVision.decoder = async () => { assert.fail('普通PNG不应解码GIF'); };
        const e = h.event('#呱瓜', { ...overrides, getReply: async () => ({ message: [{ type: 'image', url: 'https://example.com/photo' }] }) });
        await h.dispatch(e);
        assert.equal(h.calls.length, 1); assert.equal(h.judgments.length, 0);
        const content = h.calls[0].messages.at(-1).content;
        assert.equal(content.find(part => part.type === 'image_url').image_url.url, 'data:image/png;base64,' + png.toString('base64'));
        assert.match(content[0].text, /请结合引用的图片自然回应/);
        assert.doesNotMatch(content[0].text, /没有补充具体聊天内容|\[回复消息\]/);
    }
});

test('只发呱瓜引用文字会回应引用；读不到引用时明确提供缺失状态，不伪装看到图片', async t => {
    const h = pluginHarness(t);
    await h.dispatch(h.event('#呱瓜', { reply_id: 'text', getReply: async () => ({ sender: { nickname: '乙' }, raw_message: '我家的猫叫豆包' }) }));
    const content = h.calls[0].messages.at(-1).content;
    assert.match(content, /请结合引用的消息自然回应/);
    assert.match(content, /引用消息（乙 发的）.*我家的猫叫豆包/s);
    assert.equal(h.api.memory.store.data.observations.length, 0, '引用原话不作为触发者的新自述提取');
    for (const getReply of [undefined, async () => { throw Error('quote unavailable'); }, async () => ({ message: [] })]) {
        const broken = pluginHarness(t);
        await broken.dispatch(broken.event('#呱瓜', { reply_id: 'unavailable', getReply }));
        assert.equal(broken.calls.length, 1); assert.equal(broken.judgments.length, 0);
        assert.match(broken.calls[0].messages.at(-1).content, /未能取得可用的引用内容/);
    }
});

test('引用图片下载失败或模型不支持视觉时提供实际未收图状态，不编造画面', async t => {
    for (const model of ['deepseek-flash', 'deepseek-v4-pro']) {
        let downloads = 0;
        const h = pluginHarness(t, { config: { 'deepseekJS:model_type': model }, http: { get: async () => { downloads++; throw Error('image unavailable'); } } });
        await h.dispatch(h.event('#呱瓜', { reply_id: 'photo', getReply: async () => ({ message: [{ type: 'image', url: 'https://example.com/photo' }] }) }));
        assert.equal(h.calls.length, 1);
        const content = h.calls[0].messages.at(-1).content;
        assert.equal(typeof content, 'string');
        assert.match(content, /图片读取状态/);
        assert.match(content, model === 'deepseek-flash' ? /未能读取引用图片/ : /当前模型不支持图片输入/);
        assert.equal(downloads, model === 'deepseek-flash' ? 1 : 0);
    }
});

test('GIF拼图说明不占图片数量额度，四张图片仍全部上传，普通图原数据不变', async t => {
    const gif = tinyGif(), jpeg = Buffer.from([255, 216, 255, 224]); let decoded = 0;
    const h = pluginHarness(t, { http: { get: async src => ({ data: src.includes('gif') ? gif : jpeg,
        headers: { 'content-type': src.includes('gif') ? 'image/png' : 'image/jpeg' } }) } });
    h.api.gifVision.decoder = async (_bytes, selected, cell) => { decoded++; return rgbaFrames(selected, cell); };
    const images = ['https://example.com/gif', 'https://example.com/a', 'https://example.com/b', 'https://example.com/c'];
    const e = h.event('#呱瓜 看这几个图', { message: [{ type: 'text', text: '#呱瓜 看这几个图' }, ...images.map(src => ({ type: 'image', url: src }))] });
    await h.instance.chat(e);
    const content = h.calls[0].messages.at(-1).content;
    assert.equal(content.filter(part => part.type === 'image_url').length, 4);
    assert.equal(content.filter(part => part.type === 'text' && part.text.includes('6个采样帧')).length, 1);
    assert.match(content.find(part => part.type === 'image_url').image_url.url, /^data:image\/png;base64,/);
    assert.ok(content.filter(part => part.type === 'image_url').slice(1).every(part => part.image_url.url === `data:image/jpeg;base64,${jpeg.toString('base64')}`));
    assert.equal(decoded, 1);
    assert.match(h.api.memory.store.history(sessionKey(e), 3)[0].content, /附4张图片/);
    const repeated = h.event('#呱瓜 再看看', { message: [{ type: 'text', text: '#呱瓜 再看看' }, { type: 'image', url: 'https://example.com/gif-another-url' }] });
    await h.instance.chat(repeated); assert.equal(decoded, 1);
});

test('引用动图同样抽帧，解码失败时保留原图和局限说明，空前缀加图片仍正常识图', async t => {
    const gif = tinyGif();
    const h = pluginHarness(t, { http: { get: async () => ({ data: gif, headers: { 'content-type': 'image/gif' } }) } });
    h.api.gifVision.decoder = async () => { throw Error('decoder unavailable'); };
    const e = h.event('#呱瓜 看引用的图', { reply_id: 'someone-image', getReply: async () => ({ message: [{ type: 'image', url: 'https://example.com/gif' }] }) });
    await h.instance.chat(e);
    const content = h.calls[0].messages.at(-1).content;
    assert.equal(content.find(part => part.type === 'image_url').image_url.url, `data:image/gif;base64,${gif.toString('base64')}`);
    assert.ok(content.some(part => part.type === 'text' && part.text.includes('仅展示首帧')));
    const imageOnly = h.event('#呱瓜', { message: [{ type: 'text', text: '#呱瓜' }, { type: 'image', url: 'https://example.com/gif' }] });
    await h.instance.chat(imageOnly);
    assert.equal(h.calls.length, 2);
    assert.equal(h.api.conversationListening.sessions.size, 1);
    assert.ok(h.calls[1].messages.at(-1).content.some(part => part.type === 'image_url'));
});
