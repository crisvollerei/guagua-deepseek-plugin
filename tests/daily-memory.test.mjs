import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { MemoryService } from '../guagua-memory.mjs';

const profile = { users: { '33333': { name: '阿明' }, '44444': { name: '阿红' }, '22222': { name: '主人', role: 'master' } }, pending: [] };
const quiet = { info() {}, warn() {}, error() {} };
const result = memories => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ memories }) } }] });

function fixture(t, complete = async () => result([])) {
    const base = path.resolve('tests/.tmp'); fs.mkdirSync(base, { recursive: true });
    const directory = fs.mkdtempSync(path.join(base, 'daily-memory-'));
    let now = Date.parse('2026-11-08T06:00:00Z');
    const options = { directory, logger: quiet, now: () => now, getProfile: () => profile, complete };
    let service = new MemoryService(options);
    const f = { directory, get service() { return service; }, get store() { return service.store; }, now: () => now,
        advance(ms) { now += ms; },
        source(text, id = 's1', extra = {}) { return { id, text, botId: '12345', session: '12345:group:99999', groupId: '99999', speakerId: '33333', at: new Date(now).toISOString(), ...extra }; },
        event(id, user = '33333', group = '99999') { return { self_id: '12345', group_id: group, user_id: user, message_id: id, time: now / 1000, sender: { nickname: user === '33333' ? '阿明' : '阿红' }, message: [] }; },
        context(query = '', user = '33333', group = '99999') { service.roster.noteMessage(f.event(`context-${now}`, user, group)); return { ...service.roster.context(f.event('ctx', user, group), [user]), query }; },
        reload() { service.dispose(); service = new MemoryService(options); return service; }
    };
    service.roster.noteMessage(f.event('initial'));
    t.after(() => { service.dispose(); assert.equal(path.dirname(path.resolve(directory)), base); fs.rmSync(directory, { recursive: true, force: true }); });
    return f;
}

function raw(s, type = 'entity', extra = {}) {
    return { type, userid: s.speakerId, scope: type === 'event' || type === 'agreement' ? 'group' : 'global', assertion: 'affirmed',
        source_id: s.id, evidence: s.text, content: s.text, ...extra };
}
function cat(s, extra = {}) { return raw(s, 'entity', { entity: { name: '豆包', kind: '猫', relation: '宠物', attributes: '橘猫' }, claim: { field: 'ownership', value: '豆包' }, ...extra }); }
function event(s, extra = {}) { return raw(s, 'event', { claim: { field: 'event', value: '医院' }, ...extra }); }

test('已活动的近期事项明确取消、改期和完成直接更新，不需要主人再确认', t => {
    const f = fixture(t), first = f.source('我明天去医院'); f.service.ingest([event(first)], [first]);
    const old = f.store.data.records[0]; f.advance(60000);
    const changed = f.source('我改到后天去医院', 'change');
    f.service.ingest([event(changed, { operation: 'reschedule', target_id: old.id, replaces: old.id })], [changed]);
    assert.equal(f.store.data.records[0].status, 'superseded');
    assert.equal(f.store.data.records[1].status, 'active');
    assert.equal(f.store.data.records[1].replaces, old.id);
    const done = f.source('我在医院的检查已经完成了', 'done');
    f.service.ingest([event(done, { operation: 'complete', target_id: f.store.data.records[1].id })], [done]);
    assert.equal(f.store.data.records[1].status, 'completed');
    assert.equal(f.store.pending().length, 0);
    const next = f.source('我明天去医院复查', 'next'); f.service.ingest([event(next)], [next]);
    const active = f.store.data.records.at(-1), cancel = f.source('我明天不去医院复查了', 'cancel');
    f.service.ingest([event(cancel, { assertion: 'negated', operation: 'cancel', target_id: active.id })], [cancel]);
    assert.equal(f.store.data.records.at(-1).status, 'cancelled');
    assert.equal(f.store.context(f.context('医院')), '');
});

test('忽略仅抑制同次近期安排，不永久屏蔽以后日期的同一句安排', t => {
    const f = fixture(t), first = f.source('我明天去医院'); f.service.ingest([event(first)], [first]);
    f.store.manage('忽略', 'M000001', '', 'owner');
    f.service.ingest([event(first)], [first]); assert.equal(f.store.data.records.length, 1);
    f.advance(86400000); const next = f.source('我明天去医院', 'next-day'); f.service.ingest([event(next)], [next]);
    assert.equal(f.store.data.records.length, 2); assert.equal(f.store.data.records[0].status, 'ignored'); assert.equal(f.store.data.records[1].status, 'active');
});

test('否定取消、传闻和引用不自动取消当前事项；不同人不同范围也不能结束旧安排', t => {
    const f = fixture(t), first = f.source('我明天去医院'); f.service.ingest([event(first)], [first]);
    const old = f.store.data.records[0];
    const otherDate = f.source('我下周五去医院的安排取消了', 'other-date');
    f.service.ingest([event(otherDate, { assertion: 'negated', operation: 'cancel', target_id: old.id })], [otherDate]);
    assert.equal(f.store.data.records[0].status, 'active');
    for (const [line, assertion, quoted] of [['我没有取消去医院', 'affirmed', false], ['我不是不去医院', 'negated', false], ['听说我取消去医院', 'reported', false], ['我取消去医院', 'negated', true]]) {
        const s = f.source(line, line, { quoted });
        f.service.ingest([event(s, { assertion, operation: 'cancel', target_id: old.id })], [s]);
        assert.equal(f.store.data.records[0].status, 'active');
    }
    f.service.roster.noteMessage(f.event('other', '44444'));
    const other = f.source('我取消去医院', 'other', { speakerId: '44444' });
    f.service.ingest([event(other, { assertion: 'negated', target_id: old.id })], [other]);
    const elsewhere = f.source('我取消去医院', 'elsewhere', { groupId: '11111', session: '12345:group:11111' });
    f.service.ingest([event(elsewhere, { assertion: 'negated', target_id: old.id })], [elsewhere]);
    assert.equal(f.store.data.records[0].status, 'active');
});

test('临时偏好按原时段到期，不再召回或提醒；稳定搬家和入职不会因最近而过期', t => {
    const f = fixture(t), recent = f.source('我这两天喜欢喝绿茶');
    f.service.ingest([raw(recent, 'preference', { claim: { field: 'preference', value: '绿茶' } })], [recent]);
    const state = f.store.data.records[0];
    assert.equal(state.scope.kind, 'group'); assert.equal(state.transient, true);
    assert.equal(Date.parse(state.expiresAt) - f.now(), 2 * 86400000);
    for (const [line, field, value] of [['我最近搬到北京', 'residence', '北京'], ['我近期入职某公司', 'occupation', '某公司']]) {
        const s = f.source(line, line); f.service.ingest([raw(s, 'fact', { claim: { field, value } })], [s]);
        assert.equal(f.store.data.records.at(-1).scope.kind, 'person'); assert.equal(f.store.data.records.at(-1).expiresAt, undefined);
    }
    const sick = f.source('我目前发烧', 'sick'); f.service.ingest([raw(sick, 'fact', { claim: { field: 'other', value: '发烧' } })], [sick]);
    assert.ok(f.store.data.records.at(-1).expiresAt);
    f.advance(8 * 86400000); f.store.cleanup();
    assert.equal(f.store.data.records[0].status, 'expired');
    assert.ok(f.store.pending().every(record => !record.transient));
    assert.doesNotMatch(f.store.context(f.context('绿茶')), /绿茶|发烧/);
});

test('相同实体同一事实的复述只更新证据，增加新属性仍保留待确认记录', t => {
    const f = fixture(t), first = f.source('我养了一只橘猫，名字叫豆包'); f.service.ingest([cat(first)], [first]);
    f.store.manage('确认', 'M000001', '', 'owner'); f.advance(60000);
    const again = f.source('我家的豆包是橘猫', 'again'); f.service.ingest([cat(again)], [again]);
    assert.equal(f.store.data.records.length, 1); assert.equal(f.store.data.records[0].status, 'confirmed');
    assert.equal(f.store.data.records[0].evidenceTrail[0].messageId, 'again');
    const trait = f.source('我的猫豆包胆子很小', 'trait');
    f.service.ingest([cat(trait, { entity: { name: '豆包', kind: '猫', relation: '宠物', attributes: '胆子很小' }, claim: { field: 'trait', value: '胆子很小' } })], [trait]);
    assert.equal(f.store.data.records.length, 2); assert.equal(f.store.data.records[1].status, 'pending');
});

test('稳定事实变化保留旧确认，清楚标记新说法；待确认忽略或过期后标记动态消失', t => {
    const f = fixture(t), old = f.source('我住上海'); f.service.ingest([raw(old, 'fact', { claim: { field: 'residence', value: '上海' } })], [old]);
    f.store.manage('确认', 'M000001', '', 'owner');
    const moved = f.source('我最近搬到北京', 'moved'); f.service.ingest([raw(moved, 'fact', { claim: { field: 'residence', value: '北京' } })], [moved]);
    assert.equal(f.store.data.records[0].status, 'confirmed'); assert.equal(f.store.data.records[1].replaces, 'M000001');
    assert.match(f.store.context(f.context('住哪里')), /有较新未确认说法/);
    f.store.manage('忽略', 'M000002', '', 'owner'); assert.doesNotMatch(f.store.context(f.context('住哪里')), /有较新未确认说法/);
    const fresh = f.source('我更正住所，现在住杭州', 'fresh'); f.service.ingest([raw(fresh, 'fact', { claim: { field: 'residence', value: '杭州' } })], [fresh]);
    f.store.manage('确认', f.store.data.records.at(-1).id, '', 'owner'); assert.equal(f.store.data.records[0].status, 'superseded');
});

test('宠物泛称能从较多人物资料中召回；多宠物时清理旧唯一焦点，话题和发言人分开', t => {
    const f = fixture(t), first = f.source('我养了一只橘猫，名字叫豆包'); f.service.ingest([cat(first)], [first]);
    for (let i = 0; i < 16; i++) { f.advance(1000); f.store.change(data => f.store.addTo(data, { type: 'fact', subjectId: '33333', scope: { kind: 'person' }, content: `我常玩的游戏是游戏${i}`, status: 'confirmed', source: {} })); }
    const ctx = { ...f.context('我那只猫怎么样'), topicId: 'topic-A', focusUserId: '33333' };
    assert.match(f.service.context(ctx), /豆包/);
    assert.equal(f.service.entityFocus.size, 1);
    const dog = f.source('我的狗叫元宝', 'dog'); f.service.ingest([raw(dog, 'entity', { entity: { name: '元宝', kind: '狗', relation: '宠物' }, claim: { field: 'ownership', value: '元宝' } })], [dog]);
    assert.match(f.service.context({ ...ctx, query: '我的宠物怎么样' }), /元宝/);
    assert.equal(f.service.entityFocus.size, 0);
    f.service.context({ ...ctx, query: '豆包怎么样' });
    f.service.context({ ...ctx, topicId: 'topic-B', focusUserId: '44444', query: '它怎么样' });
    assert.equal(f.service.entityFocus.size, 1, '另一个话题/发言人不能继承豆包焦点');
    f.advance(91000); f.service.context({ ...ctx, query: '它怎么样' }); assert.equal(f.service.entityFocus.size, 0);
});

test('群知识有独立群主体，作者离群仍可查询，但不扩大个人门禁或跨群资格', t => {
    const f = fixture(t), rule = f.source('本群服务器地址是game.example');
    f.service.ingest([raw(rule, 'fact', { userid: '', subject_kind: 'group', scope: 'group', claim: { field: 'server', value: 'game.example' } })], [rule]);
    const personal = f.source('我养了一只橘猫，名字叫豆包', 'personal'); f.service.ingest([cat(personal)], [personal]);
    assert.equal(f.store.data.records[0].subjectKind, 'group');
    f.service.roster.handleNotice({ ...f.event('leave'), post_type: 'notice', notice_type: 'group', sub_type: 'decrease' });
    const ctx = f.context('本群服务器地址', '44444');
    assert.match(f.store.context(ctx), /game\.example/);
    assert.doesNotMatch(f.store.context({ ...ctx, query: '豆包' }), /豆包/);
    assert.equal(f.store.context({ botId: '12345', groupId: '99999', userIds: ['33333'], query: '服务器' }), '');
    assert.equal(f.store.context(f.context('服务器', '44444', '11111')), '');
    f.service.roster.handleNotice({ ...f.event('bot-left', '12345'), post_type: 'notice', notice_type: 'group', sub_type: 'decrease' });
    assert.equal(f.store.context(ctx), '');
});

test('群知识审核展示明确群归属，确认全部可确认而不能改绑定为成员', t => {
    const f = fixture(t), s = f.source('本群群规是禁止刷屏');
    f.service.ingest([raw(s, 'fact', { userid: '', subject_kind: 'group', scope: 'group', claim: { field: 'group_rule', value: '禁止刷屏' } })], [s]);
    const record = f.store.data.records[0], owner = { self_id: '12345', user_id: '22222' };
    const pages = f.service.pages([record], '待确认').join('\n'); assert.match(pages, /群 99999 的知识/); assert.doesNotMatch(pages, /对应成员待识别/);
    const review = f.service.beginReview(owner, [record]); f.service.rememberReceipt(owner, review, { message_id: 'review' });
    const plan = f.service.planReview(owner, '确认全部'); assert.equal(plan.skipped.length, 0); assert.equal(plan.operations.length, 1);
    f.store.manageMany(plan.operations, '22222'); assert.equal(f.store.data.records[0].status, 'confirmed');
    assert.throws(() => f.store.manage('确认', record.id, '33333', '22222'), /群知识不能绑定/);
});

test('批量观察原子提取且持久去重，跨消息命名有逐条证据，不能跨人或跳过新实体', async t => {
    let payload, calls = 0;
    const f = fixture(t, async params => { calls++; payload = JSON.parse(params.messages.at(-1).content); return result([]); });
    const firstEvent = f.event('fragment1'), first = { event: firstEvent, content: '我养了只猫' };
    f.service.observeMany([first], { immediate: true }); await new Promise(resolve => setImmediate(resolve));
    f.advance(1000);
    const second = { event: f.event('fragment2'), content: '它叫豆包' };
    const sources = f.service.observeMany([second], { immediate: false, context: [first] });
    const queued = f.store.data.observations[0]; assert.equal(queued.references[0].text, first.content);
    const combined = raw(sources[0], 'entity', { content: '猫叫豆包', entity: { name: '豆包', kind: '猫', relation: '宠物' }, claim: { field: 'ownership', value: '豆包' },
        evidence_parts: [{ source_id: queued.references[0].id, text: first.content }, { source_id: queued.id, text: second.content }] });
    f.service.ingest([combined], [queued]);
    assert.equal(f.store.data.records[0].subjectId, '33333'); assert.equal(f.store.data.records[0].entity.name, '豆包');
    assert.equal(f.store.data.records[0].source.fragments.length, 2);
    f.service.observeMany([first], { immediate: false }); assert.equal(f.store.data.observations.length, 1);
    f.advance(31000); await f.service.processExtractions(); assert.ok(payload.messages[0].references.length);
    assert.equal(calls, 2); f.reload();
    f.service.observeMany([first, second], { immediate: false }); assert.equal(f.store.data.observations.length, 0);
});

test('同群同人另开话题后，两分钟内的原话也不互相补全；已有队列重启后仍按话题整理', async t => {
    const batches = [];
    const f = fixture(t, async params => {
        batches.push(JSON.parse(params.messages.at(-1).content).messages);
        return result([]);
    });
    const first = { event: f.event('cat-topic'), content: '我养了只猫' };
    const [a] = f.service.observeMany([first], { topicId: 'A', immediate: false });
    f.advance(1000);
    const [b] = f.service.observeMany([{ event: f.event('other-topic'), content: '它叫豆包' }],
        { topicId: 'B', immediate: false, context: [first] });
    assert.deepEqual(f.store.data.observations[1].references, []);
    const proposed = cat(b, { content: '猫叫豆包', evidence_parts: [
        { source_id: a.id, text: a.text }, { source_id: b.id, text: b.text }] });
    assert.equal(f.service.ingest([proposed], [a, b]), 0);
    assert.equal(f.service.ingest([proposed], [{ ...b, references: [{ ...a, topicId: undefined }] }]), 0);
    // 模拟升级前已经入队的跨话题参考。
    f.store.change(data => { data.observations[1].references = [a]; });
    f.reload(); f.advance(31000);
    await f.service.processExtractions(); await f.service.processExtractions();
    assert.deepEqual(batches.map(batch => batch.map(source => source.id)), [[a.id], [b.id]]);
    assert.deepEqual(batches[1][0].references, []);
    assert.equal(f.service.ingest([proposed], [{ ...a, topicId: b.topicId }, b]), 1);
    assert.deepEqual(f.store.data.records[0].source.fragments.map(part => part.id), [a.id, b.id]);
});

test('引用稳定资料不作为当前发言witness；缺原时间的相对安排不入活动', t => {
    const f = fixture(t); f.service.roster.noteMessage(f.event('red', '44444'));
    const quoted = f.event('quoted', '44444'); delete quoted.time; quoted.originalTimeUnknown = true;
    const sources = f.service.observeMany([{ event: quoted, content: '我明天去医院', quoted: true }], { immediate: false });
    assert.equal(sources[0].originalTimeUnknown, true);
    f.service.ingest([event(sources[0])], sources); assert.equal(f.store.data.records.length, 0);
    const stable = f.service.observeMany([{ event: { ...quoted, message_id: 'stable-quote' }, content: '我养了一只橘猫，名字叫豆包', quoted: true }], { immediate: false });
    f.service.ingest([cat(stable[0])], stable); assert.equal(f.store.data.records[0].subjectId, '44444');
    assert.equal(f.store.data.records[0].source.originalTimeUnknown, true);
    assert.equal(f.store.data.people['44444'].lastSeenAt, undefined);
    const outsider = f.event('outsider', '77777'); assert.equal(f.service.observeMany([{ event: outsider, content: '我有猫', quoted: true }], { immediate: false }).length, 0);
    assert.ok(!f.service.roster.ids('12345', '99999').includes('77777'));
});

test('旧v3近期状态按原时间补期限，载入不改原文件，稳定资料不变且再次载入幂等', t => {
    const f = fixture(t), rawData = structuredClone(f.store.data);
    rawData.records.push({ id: 'M000001', type: 'preference', subjectId: '33333', scope: { kind: 'group', groupId: '99999' }, status: 'pending', content: '我这两天喜欢喝绿茶',
        source: { speakerId: '33333', at: '2026-11-01T06:00:00.000Z', quote: '我这两天喜欢喝绿茶' }, createdAt: '2026-11-01T06:00:00.000Z' });
    rawData.nextId = 2; f.service.dispose();
    const file = path.join(f.directory, 'memory.json'), original = JSON.stringify(rawData, null, 2); fs.writeFileSync(file, original);
    f.reload(); const migrated = structuredClone(f.store.data.records[0]);
    assert.equal(migrated.transient, true); assert.equal(migrated.expiresAt, '2026-11-03T06:00:00.000Z');
    assert.equal(migrated.status, 'pending'); assert.deepEqual(migrated.source, rawData.records[0].source);
    assert.equal(f.store.usable(migrated), false); assert.equal(fs.readFileSync(file, 'utf8'), original);
    f.reload(); assert.deepEqual(f.store.data.records[0], migrated);
});

test('主回复收件人仅作为metadata跨续发和重启保留，不混入历史正文', t => {
    const f = fixture(t), key = '12345:group:99999', delivery = { id: 'reply', history: ['第一段'], recordedParts: 0 };
    f.store.recordReply(key, delivery, '你好', 8, { userId: '33333', records: [] });
    delivery.history.push('第二段'); f.store.recordReply(key, delivery, '你好', 8, { userId: '33333', records: [] });
    f.reload(); const message = f.store.history(key, 8).find(row => row.role === 'assistant');
    assert.equal(message.replyToUserId, '33333'); assert.equal(message.content, '第一段\n\n第二段');
    f.store.appendHistory(key, [{ role: 'assistant', content: '答复', replyToUserId: '44444' }], 8);
    assert.equal(f.store.history(key, 8).at(-1).replyToUserId, '44444');
});
