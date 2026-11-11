import test from 'node:test';
import assert from 'node:assert/strict';
import { quotedHarness, message, turn, deferred } from './plugin-harness.mjs';
import { FakeClock } from './fake-clock.mjs';
import { MemoryStore, sessionKey } from '../guagua-memory.mjs';

const fact = '我养了一只猫叫豆包';
const payload = params => JSON.parse(params.messages[1].content);
const pet = (source, evidence = fact) => ({ type: 'entity', userid: source.speakerId, scope: 'global', assertion: 'affirmed',
    content: fact, entity: { name: '豆包', kind: '猫', relation: '宠物' }, claim: { field: 'ownership', value: '豆包' },
    source_id: source.id, evidence });
const extractPet = params => message({ memories: payload(params).messages.filter(source => source.text.includes(fact)).map(source => pet(source)) });
async function drain(h) {
    for (let i = 0; i < 50; i++) {
        if (h.api.memory.extracting) await turn();
        else if (h.api.memory.store.data.observations.some(source => source.readyAt <= h.api.memory.now())) await h.api.memory.processExtractions();
        else return;
    }
    assert.fail('extraction did not drain');
}
function retryEvent(h, original, body = '#呱瓜 记住这条', overrides = {}) {
    return h.event(body, { reply_id: original.message_id, getReply: async () => ({ user_id: original.user_id,
        group_id: original.group_id, message_id: original.message_id, sender: original.sender,
        message: [{ type: 'text', text: original.msg }] }), ...overrides });
}
const entries = h => Object.values(h.api.memory.store.data.intakeLog || {});

test('准入时先保留原话，接话判断不选记忆也能收录；其他成员、群和命令仍不进入', async t => {
    const clock = new FakeClock(), extracted = [];
    const h = quotedHarness(t, { listeningClock: clock, judgment: params => message({ action: 'reply', message_ids: payload(params).messages.map(m => m.id) }),
        extraction: params => { extracted.push(payload(params)); return extractPet(params); } });
    await h.instance.chat(h.event('#呱瓜 聊点宠物')); await drain(h); extracted.length = 0;
    const original = h.event(fact);
    await h.instance.accept(original);
    assert.equal(extracted.length, 0);
    assert.ok(entries(h).some(entry => entry.text === fact && entry.state === 'queued'));
    for (const e of [h.event('其他成员的内容', { user_id: 44444 }), h.event('其他群的内容', { group_id: 88888 }), h.event('#其他插件命令')]) await h.instance.accept(e);
    assert.ok(entries(h).every(entry => !/其他成员|其他群|其他插件/.test(entry.text)));
    await clock.advance(8000); await drain(h);
    assert.equal(h.judgments.length, 1);
    assert.equal(h.calls.length, 2);
    assert.equal(h.api.memory.store.data.records[0].entity.name, '豆包');
    assert.equal(entries(h).find(entry => entry.text === fact).state, 'stored');
});

test('silent和损坏的接话结果都不能丢掉已准入的有用原话', async t => {
    for (const judgment of [() => message({ action: 'silent' }), () => message({ action: 'broken' })]) {
        const clock = new FakeClock();
        const h = quotedHarness(t, { listeningClock: clock, judgment, extraction: extractPet });
        await h.instance.chat(h.event('#呱瓜 聊天')); await drain(h);
        await h.instance.accept(h.event(fact)); await clock.advance(8000); await drain(h);
        assert.equal(h.api.memory.store.data.records[0].subjectId, '33333');
        assert.equal(h.calls.length, 1);
    }
});

test('普通群聊和超过话题期限的补充不进入原话缓冲', async t => {
    const clock = new FakeClock(); const h = quotedHarness(t, { listeningClock: clock });
    await h.instance.accept(h.event(fact)); assert.equal(entries(h).length, 0);
    await h.instance.chat(h.event('#呱瓜 先聊')); await drain(h);
    await clock.advance(61000);
    await h.instance.accept(h.event('过期后我又养了一只狗'));
    assert.ok(entries(h).every(entry => !entry.text.includes('过期后')));
});

test('聊天截断和记忆原话分开，500字后的明确事实仍可入库', async t => {
    const h = quotedHarness(t, { extraction: extractPet });
    const text = '普通铺垫。'.repeat(120) + fact;
    await h.instance.chat(h.event('#呱瓜 ' + text)); await drain(h);
    assert.ok(h.api.memory.store.data.records.some(record => record.entity?.name === '豆包'));
    assert.ok(entries(h)[0].text.endsWith(fact));
    assert.ok(h.calls[0].messages.at(-1).content.includes('内容过长已截断'));
});

test('空结果和被拒候选保留原话、具体原因及稳定收录编号，重启可查看', async t => {
    for (const invalid of [false, true]) {
        const h = quotedHarness(t, { extraction: params => message({ memories: invalid ? [{ ...pet(payload(params).messages[0]), evidence: '我有一只名叫豆包的猫' }] : [] }) });
        await h.instance.chat(h.event('#呱瓜 ' + fact)); await drain(h);
        const entry = entries(h)[0];
        assert.equal(entry.state, invalid ? 'rejected' : 'empty');
        assert.match(entry.id, /^C\d{6}$/);
        assert.equal(entry.text, fact);
        assert.equal(h.api.memory.store.data.observations.length, 0);
        if (invalid) assert.match(entry.reason, /证据/);
        const reloaded = new MemoryStore(h.root);
        assert.equal(reloaded.data.intakeLog[entry.sourceId].id, entry.id);
        await h.dispatch(h.event('#memory 最近'));
        assert.ok(JSON.stringify(h.replies).includes(entry.id));
        await h.dispatch(h.event('#memory 收录 ' + entry.id));
        assert.ok(JSON.stringify(h.replies).includes(fact));
    }
});

test('引用同一原消息要求记住能重试空结果，回执由真实入库决定且可继续引用聊天', async t => {
    let attempts = 0;
    const h = quotedHarness(t, { extraction: params => ++attempts === 1 ? message({ memories: [] }) : extractPet(params), response: () => message('普通回答') });
    const original = h.event('#呱瓜 ' + fact);
    await h.instance.chat(original); await drain(h);
    assert.equal(h.api.memory.store.data.records.length, 0);
    await h.instance.chat(retryEvent(h, original));
    assert.equal(h.api.memory.store.data.records.length, 1);
    assert.equal(h.api.memory.store.data.records[0].status, 'pending');
    assert.match(JSON.stringify(h.sent.at(-1).payload), /已收录 1 条.*待主人确认/);
    assert.equal(h.calls.length, 1);
    assert.ok(h.api.quoteContinuations.find(sessionKey(original), h.sent.at(-1).receipt.message_id));
    await h.receive(h.follow('接着聊聊它'));
    assert.equal(h.calls.length, 2);
});

test('明确记住却无可用候选时不发送模型的虚假成功回答', async t => {
    const h = quotedHarness(t, { extraction: () => message({ memories: [] }), response: () => message('好呀，我完全记住啦。') });
    await h.instance.chat(h.event('#呱瓜 记住，我养了一只猫叫豆包'));
    assert.equal(h.calls.length, 0);
    assert.doesNotMatch(JSON.stringify(h.sent), /完全记住啦/);
    assert.match(JSON.stringify(h.sent), /原话已保留.*没有新增可用记忆/);
    assert.equal(entries(h)[0].requested, true);
});

test('判断期间补充导致重跑，已整理的记忆请求仍能取得自己的真实结果', async t => {
    const clock = new FakeClock(), began = deferred(), finish = deferred();
    const h = quotedHarness(t, { listeningClock: clock, extraction: extractPet, judgment: async (params, count) => {
        if (count === 1) { began.resolve(); await finish.promise; }
        const selected = payload(params).messages.find(source => source.explicit_memory_request);
        return message({ action: 'reply', message_ids: [selected.id] });
    } });
    await h.instance.chat(h.event('#呱瓜 先聊')); await drain(h);
    await h.instance.accept(h.event('记住，' + fact));
    const pending = clock.advance(8000); await began.promise;
    await h.instance.accept(h.event('还有点事，稍后再聊'));
    finish.resolve(); await pending;
    await clock.advance(8000); await drain(h);
    assert.equal(h.judgments.length, 2);
    assert.match(JSON.stringify(h.sent.at(-1).payload), /已收录 1 条.*待主人确认/);
    assert.doesNotMatch(JSON.stringify(h.sent.at(-1).payload), /没有取得可收录的原话/);
});

test('同批多个记忆请求分别核对，不能用别条请求的成功结果冒充本条已收录', async t => {
    const clock = new FakeClock();
    const h = quotedHarness(t, { listeningClock: clock, extraction: extractPet, judgment: params => {
        const selected = payload(params).messages.find(source => source.text.includes('我养了一只狗叫元宝'));
        return message({ action: 'reply', message_ids: [selected.id] });
    } });
    await h.instance.chat(h.event('#呱瓜 先聊')); await drain(h);
    await h.instance.accept(h.event('记住，' + fact));
    await h.instance.accept(h.event('记住，我养了一只狗叫元宝'));
    await h.instance.accept(h.event('这两件事先告诉你'));
    await clock.advance(14000); await drain(h);
    assert.equal(h.api.memory.store.data.records.length, 1);
    assert.match(JSON.stringify(h.sent.at(-1).payload), /原话已保留.*没有新增可用记忆/);
    assert.doesNotMatch(JSON.stringify(h.sent.at(-1).payload), /已收录 1 条/);
});

test('忽略或删除的事实在明确重试时仍不能复活', async t => {
    const h = quotedHarness(t, { extraction: extractPet });
    const original = h.event('#呱瓜 ' + fact);
    await h.instance.chat(original); await drain(h);
    const old = h.api.memory.store.data.records[0]; h.api.memory.store.manage('忽略', old.id);
    await h.instance.chat(retryEvent(h, original));
    assert.equal(h.api.memory.store.data.records.length, 1);
    assert.equal(h.api.memory.store.data.records[0].status, 'ignored');
    assert.match(JSON.stringify(h.sent.at(-1).payload), /忽略或删除设置/);
});

test('主人可以按C编号重试整理失败的原话，自定义命令和权限仍生效', async t => {
    let fail = true;
    const h = quotedHarness(t, { pluginConfig: { command: { memoryCommand: '#mem' } }, extraction: params => {
        if (fail) throw Error('暂时不可用'); return extractPet(params);
    } });
    await h.instance.chat(h.event('#呱瓜 ' + fact)); await drain(h);
    const entry = entries(h)[0]; assert.equal(entry.state, 'failed');
    fail = false;
    assert.equal(await h.dispatch(h.event('#mem 重试 ' + entry.id, { isMaster: false })), 'denied');
    assert.equal(h.api.memory.store.data.records.length, 0);
    await h.dispatch(h.event('#mem 重试 ' + entry.id));
    assert.equal(h.api.memory.store.data.records.length, 1);
    assert.equal(entries(h)[0].state, 'stored');
});

test('已知唯一事物的代词新属性有持久关联，但原话不被改写成带名字的证据', async t => {
    const h = quotedHarness(t, { extraction: params => {
        const p = payload(params), source = p.messages[0];
        if (source.text.includes('叫豆包')) return extractPet(params);
        const anchor = p.knownMemories.find(record => record.entity?.name === '豆包');
        assert.ok(anchor);
        return message({ memories: [{ type: 'entity', userid: source.speakerId, scope: 'global', assertion: 'affirmed',
            entity_ref: anchor.entity_ref, entity: { name: '豆包', kind: '猫', relation: '宠物', attributes: '怕水' },
            content: '豆包很怕水', claim: { field: 'trait', value: '怕水' }, source_id: source.id, evidence: source.text }] });
    } });
    await h.instance.chat(h.event('#呱瓜 ' + fact)); await drain(h);
    const anchor = h.api.memory.store.data.records[0];
    await h.instance.chat(h.event('#呱瓜 它很怕水')); await drain(h);
    const trait = h.api.memory.store.data.records.find(record => record.claim?.field === 'trait');
    assert.ok(trait);
    assert.equal(trait.entityRef, anchor.id);
    assert.equal(trait.entity.attributes, '怕水');
    assert.equal(trait.source.quote, '它很怕水');
    assert.equal(trait.source.fact, '它很怕水');
    assert.equal(trait.status, 'pending');
    const context = await h.api.memory.queryContext(h.event('查看'), ['33333']);
    assert.match(h.api.memory.context({ ...context, query: '怕水' }), /对象豆包/);
    h.api.memory.store.manage('忽略', anchor.id);
    assert.doesNotMatch(h.api.memory.context({ ...context, query: '怕水' }), /怕水/);
});

test('多个关联对象或其他发言人的代词不能凭模型编号强行绑定', async t => {
    const h = quotedHarness(t, { extraction: () => message({ memories: [] }) });
    const e = h.event('原话'); h.api.memory.roster.noteMessage(e);
    const source = h.api.memory.source(e, fact);
    h.api.memory.ingest([pet(source)], [source]);
    const anchor = h.api.memory.store.data.records[0];
    const other = h.api.memory.source(h.event('我养了一只狗叫元宝'), '我养了一只狗叫元宝');
    h.api.memory.ingest([{ ...pet(other, other.text), content: other.text, entity: { name: '元宝', kind: '狗', relation: '宠物' }, claim: { field: 'ownership', value: '元宝' } }], [other]);
    const raw = (s, uid = s.speakerId) => ({ type: 'entity', userid: uid, scope: 'global', assertion: 'affirmed',
        entity_ref: anchor.id, entity: { name: '豆包', kind: '猫', relation: '宠物', attributes: '怕水' }, content: '豆包怕水',
        claim: { field: 'trait', value: '怕水' }, source_id: s.id, evidence: s.text });
    const ambiguous = h.api.memory.source(h.event('它怕水'), '它怕水');
    assert.equal(h.api.memory.ingest([raw(ambiguous)], [ambiguous]), 0);
    const newcomer = h.api.memory.source(h.event('它怕水', { user_id: 44444 }), '它怕水');
    h.api.memory.roster.noteMessage(h.event('新人', { user_id: 44444 }));
    assert.equal(h.api.memory.ingest([raw(newcomer, '33333')], [newcomer]), 0);
    assert.equal(h.api.memory.store.data.records.length, 2);
});

test('补充前文时保留首次捕获的原时间，不把旧分句排到新分句之后', async t => {
    const h = quotedHarness(t); let now = Date.parse('2026-11-09T06:00:00Z');
    h.api.memory.now = h.api.memory.store.now = h.api.memory.roster.now = () => now;
    const first = { event: h.event('我养了一只猫'), content: '我养了一只猫' };
    h.api.memory.observeMany([first], { immediate: false, defer: true, topicId: 'topic' });
    const at = entries(h)[0].at; now += 1000;
    const second = { event: h.event('它叫豆包'), content: '它叫豆包' };
    h.api.memory.observeMany([second], { immediate: false, defer: true, topicId: 'topic', context: [first] });
    const queued = h.api.memory.store.data.observations.find(source => source.text === '它叫豆包');
    assert.equal(queued.references.find(source => source.text === '我养了一只猫').at, at);
    assert.ok(queued.at > at);
    assert.equal(h.api.memory.extracting, false);
});

test('具名属性和之后省略名字的属性持续关联到同一原始事物', async t => {
    const h = quotedHarness(t, { extraction: params => {
        const source = payload(params).messages[0];
        if (source.text.includes('叫豆包')) return extractPet(params);
        const value = source.text.includes('怕水') ? '怕水' : '喜欢晒太阳';
        return message({ memories: [{ type: 'entity', userid: source.speakerId, scope: 'global', assertion: 'affirmed',
            entity: { name: '豆包', kind: '猫', relation: '宠物', attributes: value }, content: '豆包' + value,
            claim: { field: 'trait', value }, source_id: source.id, evidence: source.text }] });
    } });
    await h.instance.chat(h.event('#呱瓜 ' + fact)); await drain(h);
    const anchor = h.api.memory.store.data.records[0];
    await h.instance.chat(h.event('#呱瓜 豆包怕水')); await drain(h);
    await h.instance.chat(h.event('#呱瓜 它喜欢晒太阳')); await drain(h);
    assert.equal(h.api.memory.store.data.records.length, 3);
    assert.ok(h.api.memory.store.data.records.slice(1).every(record => record.entityRef === anchor.id));
    assert.ok(h.api.memory.store.data.records.slice(1).every(record => record.entity.kind === '猫'));
});

test('仅返回已知实体编号也能关联字面新属性，否定不会被继承字段反写', async t => {
    const h = quotedHarness(t, { extraction: params => {
        const p = payload(params), source = p.messages[0];
        if (source.text.includes('叫豆包')) return extractPet(params);
        return message({ memories: [{ type: 'entity', userid: source.speakerId, scope: 'global', assertion: 'negated',
            entity_ref: p.knownMemories[0].entity_ref, entity: { kind: '猫', relation: '宠物' },
            content: '它不是猫', claim: { field: 'kind', value: '猫' }, source_id: source.id, evidence: source.text }] });
    } });
    await h.instance.chat(h.event('#呱瓜 ' + fact)); await drain(h);
    await h.instance.chat(h.event('#呱瓜 它不是猫')); await drain(h);
    const correction = h.api.memory.store.data.records.at(-1);
    assert.equal(correction.entity.name, '豆包');
    assert.equal(correction.entity.kind, '');
    assert.equal(correction.entity.relation, '');
    assert.equal(correction.assertion, 'negated');
});

test('最近收录支持原话搜索，其他群及机器人不能查看或重试本群原话', async t => {
    const h = quotedHarness(t);
    const original = h.event('#呱瓜 ' + fact);
    await h.instance.chat(original); await drain(h);
    const entry = entries(h)[0];
    await h.dispatch(h.event('#memory 最近 豆包'));
    assert.match(JSON.stringify(h.replies.at(-1)), /豆包/);
    assert.doesNotMatch(h.api.memory.intakeDisplay(h.event('管理', { group_id: 88888 })), /豆包/);
    assert.doesNotMatch(h.api.memory.intakeDisplay(h.event('管理', { self_id: 77777 })), /豆包/);
    await h.dispatch(h.event('#memory 重试 ' + entry.id, { group_id: 88888 }));
    assert.match(JSON.stringify(h.replies.at(-1)), /没有找到本范围/);
});

test('旧时间戳去重数据没有假冒成功状态，明确重试可以补齐收录', async t => {
    const h = quotedHarness(t, { extraction: extractPet });
    const original = h.event('#呱瓜 ' + fact), source = h.api.memory.source(original, fact);
    h.api.memory.store.change(data => { data.intakes = { [source.id]: h.api.memory.now() }; });
    h.api.memory.observeMany([{ event: original, content: fact }], { immediate: true });
    assert.equal(entries(h)[0].state, 'legacy');
    assert.equal(h.api.memory.store.data.records.length, 0);
    await h.instance.chat(retryEvent(h, original));
    assert.equal(h.api.memory.store.data.records.length, 1);
    assert.equal(entries(h).find(entry => entry.sourceId === source.id).state, 'stored');
});

test('结束的收录记录按保留期清理，待处理任务与明确要求保留的未整理原话仍留下', async t => {
    const h = quotedHarness(t); const now = h.api.memory.now();
    for (const [text, requested, queued] of [['普通过期原话', false, false], ['明确要求保留', true, false], ['还在排队', false, true]]) {
        const event = h.event(text);
        h.api.memory.observeMany([{ event, content: text, requested }], { immediate: false, defer: true });
        h.api.memory.store.change(data => {
            const entry = Object.values(data.intakeLog).at(-1);
            entry.receivedAt = now - 8 * 86400000;
            entry.state = queued ? 'queued' : 'empty';
            if (!queued) data.observations = data.observations.filter(source => source.id !== entry.sourceId);
        });
    }
    h.api.memory.store.change(data => h.api.memory.pruneIntakes(data));
    assert.deepEqual(entries(h).map(entry => entry.text), ['明确要求保留', '还在排队']);
});

test('保存原话失败不能声称已保留或启动提取，恢复后可重新收录', async t => {
    const h = quotedHarness(t, { extraction: extractPet });
    const write = h.api.memory.store.write;
    h.api.memory.store.write = () => { throw Error('模拟不可写'); };
    await h.instance.chat(h.event('#呱瓜 记住，' + fact));
    assert.match(JSON.stringify(h.sent.at(-1).payload), /未能保存原话/);
    assert.equal(entries(h).length, 0);
    assert.equal(h.api.memory.extracting, false);
    h.api.memory.store.write = write;
    await h.instance.chat(h.event('#呱瓜 记住，' + fact));
    assert.equal(h.api.memory.store.data.records.length, 1);
    assert.match(JSON.stringify(h.sent.at(-1).payload), /已收录/);
});

test('关联宠物的今天状态仍留在原群并带期限，不会被当作跨群长期属性', async t => {
    const h = quotedHarness(t, { extraction: () => message({ memories: [] }) });
    const original = h.event(fact); h.api.memory.roster.noteMessage(original);
    const source = h.api.memory.source(original, fact); h.api.memory.ingest([pet(source)], [source]);
    const stateEvent = h.event('它今天很怕水'), state = h.api.memory.source(stateEvent, '它今天很怕水');
    h.api.memory.ingest([{ type: 'entity', userid: state.speakerId, scope: 'global', assertion: 'affirmed',
        entity_ref: h.api.memory.store.data.records[0].id, entity: { name: '豆包', kind: '猫', relation: '宠物', attributes: '怕水' },
        content: state.text, claim: { field: 'trait', value: '怕水' }, source_id: state.id, evidence: state.text }], [state]);
    const record = h.api.memory.store.data.records.at(-1);
    assert.equal(record.scope.kind, 'group'); assert.equal(record.transient, true);
    assert.ok(record.expiresAt);
    const other = h.event('怕水', { group_id: 88888 }); h.api.memory.roster.noteMessage(other);
    const context = await h.api.memory.queryContext(other, ['33333']);
    assert.doesNotMatch(h.api.memory.context({ ...context, query: '怕水' }), /今天很怕水/);
});

test('明确点出当前群成员的宠物可以关联，不能把第三方代词当作引用者自述', async t => {
    const h = quotedHarness(t, { p: { version: 1, pending: [], users: { '44444': { name: '阿红' } } } });
    const ownerEvent = h.event(fact, { user_id: 44444, sender: { nickname: '阿红' } }); h.api.memory.roster.noteMessage(ownerEvent);
    const own = h.api.memory.source(ownerEvent, fact); h.api.memory.ingest([pet(own)], [own]);
    const event = h.event('阿红的猫怕水'); h.api.memory.roster.noteMessage(event);
    const source = h.api.memory.source(event, '阿红的猫怕水');
    const count = h.api.memory.ingest([{ type: 'entity', userid: '44444', scope: 'global', assertion: 'affirmed',
        entity_ref: h.api.memory.store.data.records[0].id, entity: { name: '豆包', kind: '猫', relation: '宠物', attributes: '怕水' },
        content: source.text, claim: { field: 'trait', value: '怕水' }, source_id: source.id, evidence: source.text }], [source]);
    assert.equal(count, 1);
    assert.equal(h.api.memory.store.data.records.at(-1).subjectId, '44444');
    assert.equal(h.api.memory.store.data.records.at(-1).source.speakerId, '33333');
});
