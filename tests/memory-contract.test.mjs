import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { MemoryService } from '../guagua-memory.mjs';

const quiet = { info() {}, warn() {}, error() {} };
const profile = { users: { '33333': { name: '阿明' }, '44444': { name: '阿红' }, '55555': { name: '阿蓝' } }, pending: [] };
const answer = (content, finish_reason = 'stop') => ({ choices: [{ finish_reason, message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }] });

function fixture(t, options = {}) {
    const base = path.resolve('tests/.tmp'); fs.mkdirSync(base, { recursive: true });
    const directory = fs.mkdtempSync(path.join(base, 'memory-contract-'));
    let time = Date.parse('2026-11-08T06:00:00Z');
    const service = new MemoryService({ directory, logger: quiet, now: () => time,
        getProfile: () => options.profile || profile, complete: options.complete || (async () => answer({ memories: [] })) });
    for (const user_id of ['33333', '44444', '55555']) service.roster.noteMessage({ self_id: '12345', group_id: '99999', user_id });
    t.after(() => {
        service.dispose();
        assert.equal(path.dirname(path.resolve(directory)), base);
        fs.rmSync(directory, { recursive: true, force: true });
    });
    return { service, store: service.store, directory, now: () => time, advance: ms => { time += ms; } };
}

function source(text = '我养了一只橘猫，名字叫豆包', overrides = {}) {
    return { id: 's1', session: '12345:group:99999', botId: '12345', speakerId: '33333', groupId: '99999',
        at: '2026-11-08T06:00:00.000Z', name: '阿明', text, targets: [], ...overrides };
}

function pet(s, overrides = {}) {
    return { type: 'entity', userid: '33333', scope: 'global', content: '养了一只名叫豆包的橘猫', assertion: 'affirmed',
        entity: { name: '豆包', kind: '猫', relation: '宠物', attributes: '橘猫' }, claim: { field: 'ownership', value: '豆包' },
        source_id: s.id, evidence: s.text, ...overrides };
}

test('第一人称资料不能绑定同群其他成员，提及和同群资格均不等于归属', t => {
    const { service, store } = fixture(t);
    for (const s of [source(), source('我养了一只橘猫，名字叫豆包，顺便问候44444', { targets: ['44444'] })]) {
        service.ingest([pet(s, { userid: '44444' })], [s]);
    }
    assert.equal(store.data.records.length, 0);
    const valid = source(); service.ingest([pet(valid)], [valid]);
    assert.equal(store.data.records[0].subjectId, '33333');
    service.roster.noteMessage({ self_id: '12345', group_id: '22222', user_id: '44444' });
    const context = service.roster.context({ self_id: '12345', group_id: '22222' }, ['44444']);
    assert.deepEqual(store.search(context), []);
});

test('句尾QQ和寒暄式提及不是所属证据，新买/收养资料仍属于实际发言人', t => {
    for (const [index, line] of ['我新买了一辆车，给44444看看', '我新买了一辆车，44444说不错', '我收养了猫叫元宝，问候44444'].entries()) {
        const { service, store } = fixture(t);
        const s = source(line, { id: `s${index}` });
        const record = pet(s, { type: 'fact', content: line, entity: undefined, claim: { field: 'ownership', value: index === 2 ? '元宝' : '车' } });
        service.ingest([{ ...record, userid: '44444' }], [s]);
        assert.equal(store.data.records.length, 0, '另一位当前成员不能借无关QQ提及取得资料');
        service.ingest([record], [s]);
        assert.equal(store.data.records.length, 1, '有用的自述仍正常记入实际发言人');
        assert.ok(store.data.records.every(record => record.subjectId === '33333'));
    }
});

test('明确QQ与唯一姓名的第三方事实可保留，同名歧义不得借位归属', t => {
    const { service, store } = fixture(t);
    for (const text of ['[提及用户44444]的猫叫元宝', '阿红的猫叫元宝']) {
        const s = source(text);
        service.ingest([pet(s, { userid: '44444', content: '猫叫元宝', entity: { name: '元宝', kind: '猫', relation: '宠物' }, claim: { field: 'ownership', value: '元宝' } })], [s]);
    }
    assert.ok(store.data.records.length > 0);
    assert.ok(store.data.records.every(r => r.subjectId === '44444'));
    const ambiguous = fixture(t, { profile: { users: { '33333': { name: '阿明' }, '44444': { name: '阿红' }, '55555': { name: '阿红' } }, pending: [] } });
    const s = source('阿红的猫叫元宝');
    ambiguous.service.ingest([pet(s, { userid: '44444', content: '猫叫元宝', entity: { name: '元宝', kind: '猫' } })], [s]);
    assert.equal(ambiguous.store.data.records.length, 0);
});

test('明确转述中的第一人称属于被转述者，不默认变成发言人的宠物', t => {
    const { service, store } = fixture(t), s = source('阿红说：“我养了一只猫叫元宝”');
    const claim = { content: '养了一只猫叫元宝', assertion: 'reported', entity: { name: '元宝', kind: '猫', relation: '宠物' }, claim: { field: 'ownership', value: '元宝' } };
    service.ingest([pet(s, claim)], [s]);
    assert.equal(store.data.records.length, 0);
    service.ingest([pet(s, { ...claim, userid: '44444' })], [s]);
    assert.equal(store.data.records[0].subjectId, '44444');
    assert.equal(store.data.records[0].status, 'pending');
});

test('普通呼叫不变成称呼，真人与机器人同名的明确自称仍可保留', t => {
    const { service, store } = fixture(t);
    for (const text of ['呱瓜你看看', '笨瓜说话']) {
        const s = source(text);
        service.ingest([pet(s, { type: 'alias', content: '呱瓜' })], [s]);
    }
    const s = source('我也叫呱瓜');
    service.ingest([pet(s, { type: 'alias', content: '呱瓜', entity: undefined, claim: undefined })], [s]);
    assert.equal(store.data.records.length, 1);
    assert.equal(store.data.records[0].content, '呱瓜');
    assert.equal(store.data.records[0].status, 'pending');
});

test('不支持的总结拒绝，可靠改写回落原文，实体属性逐项保留有证据的字段', t => {
    const { service, store } = fixture(t), s = source();
    service.ingest([pet(s, { type: 'fact', content: '在北京工作并拥有一辆红色汽车', entity: undefined, claim: undefined })], [s]);
    assert.equal(store.data.records.length, 0);
    service.ingest([pet(s, { entity: { name: '豆包', kind: '布偶猫', relation: '宠物', attributes: '蓝眼睛' } })], [s]);
    const record = store.data.records[0];
    assert.equal(record.content, s.text);
    assert.equal(record.entity.name, '豆包');
    assert.equal(record.entity.kind, ''); assert.equal(record.entity.attributes, '');
    assert.equal(record.entity.relation, '宠物');
});

test('从否定或条件原句摘出的肯定片段不能成为免确认事件', t => {
    const { service, store } = fixture(t);
    for (const text of ['我明天不去医院', '如果有空，我明天去医院', '我可能明天去医院', '听说明天去医院', '明天去医院？', '明天去医院的安排取消了', '明天去医院还是算了', '我想去医院']) {
        const s = source(text);
        service.ingest([pet(s, { type: 'event', content: '去医院', evidence: '去医院', entity: undefined, claim: undefined })], [s]);
    }
    assert.equal(store.data.records.length, 0);
    assert.equal(store.pending().length, 0, '不把模糊事件改塞入待确认列表');
});

test('明确肯定且证据支持的事件仍免确认，另一句否定不污染它', t => {
    const { service, store } = fixture(t), s = source('我今天不去医院。明天去图书馆');
    service.ingest([pet(s, { type: 'event', content: '明天去图书馆', evidence: '明天去图书馆', scope: 'group', entity: undefined, claim: { field: 'event', value: '图书馆' } })], [s]);
    assert.equal(store.data.records[0].status, 'active');
    assert.equal(store.data.records[0].content, '明天去图书馆');
    assert.equal(store.pending().length, 0);
    const missing = source('下周一起复习', { id: 's2' });
    service.ingest([pet(missing, { type: 'agreement', content: missing.text, assertion: undefined, entity: undefined, claim: undefined })], [missing]);
    assert.equal(store.data.records.length, 1, '缺少确定性验收不能自动生效');
});

test('否定和不确定的个人参考保留限定原文，不把半句变成肯定事实', t => {
    const { service, store } = fixture(t);
    for (const text of ['我不喜欢咖啡', '我可能喜欢咖啡']) {
        const s = source(text, { id: text });
        service.ingest([pet(s, { type: 'preference', content: '喜欢咖啡', evidence: '喜欢咖啡', entity: undefined, claim: { field: 'preference', value: '咖啡' } })], [s]);
    }
    assert.deepEqual(store.data.records.map(r => [r.status, r.content]), [['pending', '我不喜欢咖啡'], ['pending', '我可能喜欢咖啡']]);
});

test('忽略或删除后同源同实体改写不能复活，换来源重述相同事实也不复活', t => {
    for (const action of ['忽略', '删除']) {
        const { service, store } = fixture(t), s = source();
        service.ingest([pet(s)], [s]);
        const old = store.data.records[0]; store.manage(action, old.id, '', 'owner');
        service.ingest([pet(s, { content: '豆包是一只橘猫' })], [s]);
        const again = source('我的宠物豆包是一只橘猫', { id: 's2' });
        service.ingest([pet(again, { content: '宠物是豆包' })], [again]);
        assert.equal(store.data.records.length, 1);
        assert.equal(store.data.records[0].status, action === '忽略' ? 'ignored' : 'deleted');
    }
});

test('同一结构化事实换类型也不能绕过墓碑，同一原话的新实体属性不被精确去重吞掉', t => {
    const { service, store } = fixture(t), s = source();
    service.ingest([pet(s)], [s]);
    store.manage('忽略', store.data.records[0].id, '', 'owner');
    service.ingest([pet(s, { type: 'fact', content: '宠物豆包', entity: undefined })], [s]);
    assert.equal(store.data.records.length, 1);

    const other = fixture(t), line = source('我的猫豆包喜欢吃鱼，胆子很小');
    for (const attributes of ['喜欢吃鱼', '胆子很小']) {
        other.service.ingest([pet(line, { content: line.text, entity: { name: '豆包', kind: '猫', relation: '宠物', attributes }, claim: undefined })], [line]);
    }
    assert.equal(other.store.data.records.length, 2);
    assert.deepEqual(other.store.data.records.map(record => record.entity.attributes), ['喜欢吃鱼', '胆子很小']);
});

test('同条原文的其他宠物与其他事实保留，同一宠物新属性不被整个主体封锁', t => {
    const { service, store } = fixture(t), s = source('我的猫豆包和狗元宝都很可爱，我住北京');
    service.ingest([pet(s, { content: '我的猫豆包', entity: { name: '豆包', kind: '猫', relation: '宠物' } })], [s]);
    store.manage('忽略', store.data.records[0].id, '', 'owner');
    service.ingest([
        pet(s, { content: '狗元宝', entity: { name: '元宝', kind: '狗', relation: '宠物' }, claim: { field: 'ownership', value: '元宝' } }),
        pet(s, { type: 'fact', content: '住北京', entity: undefined, claim: { field: 'residence', value: '北京' } })
    ], [s]);
    const next = source('我的猫豆包喜欢吃鱼', { id: 's2' });
    service.ingest([pet(next, { content: '豆包喜欢吃鱼', entity: { name: '豆包', kind: '猫', relation: '宠物', attributes: '喜欢吃鱼' }, claim: { field: 'preference', value: '鱼' } })], [next]);
    assert.equal(store.data.records.length, 4);
    assert.equal(store.data.records.filter(r => r.status === 'pending').length, 3);
});

test('真正明确的新更正可保留为待确认，不直接覆盖忽略记录或已确认事实', t => {
    const { service, store } = fixture(t), s = source();
    service.ingest([pet(s)], [s]);
    const old = store.data.records[0]; store.manage('忽略', old.id, '', 'owner');
    const fix = source('更正：豆包其实是一只狗', { id: 's2' });
    service.ingest([pet(fix, { content: '豆包其实是一只狗', entity: { name: '豆包', kind: '狗', relation: '宠物' }, replaces: old.id })], [fix]);
    assert.equal(store.data.records.length, 2);
    assert.equal(store.data.records[0].status, 'ignored');
    assert.equal(store.data.records[1].status, 'pending');
    assert.equal(store.data.records[1].replaces, old.id);
});

test('明确结构化事实的忽略不依赖content字面一致，独立槽位仍可新增', t => {
    const { service, store } = fixture(t), s = source('我住北京，我的职业是教师');
    service.ingest([pet(s, { type: 'fact', content: '住北京', entity: undefined, claim: { field: 'residence', value: '北京' } })], [s]);
    store.manage('忽略', store.data.records[0].id, '', 'owner');
    service.ingest([
        pet(s, { type: 'fact', content: '我住北京', entity: undefined, claim: { field: 'residence', value: '北京' } }),
        pet(s, { type: 'fact', content: '职业是教师', entity: undefined, claim: { field: 'occupation', value: '教师' } })
    ], [s]);
    assert.equal(store.data.records.length, 2);
    assert.equal(store.data.records[1].claim.field, 'occupation');
});

test('提取墓碑限于当前授权范围和相关对象，仅供明确更正，不进入正式召回', async t => {
    let captured;
    const { service, store, advance } = fixture(t, { complete: async params => {
        captured = JSON.parse(params.messages.at(-1).content);
        const message = captured.messages[0];
        return answer({ memories: [pet(message, { content: '我的豆包其实是一只狗', evidence: message.text,
            entity: { name: '豆包', kind: '狗', relation: '宠物' }, replaces: captured.suppressedFacts[0].id })] });
    } });
    const s = source(); service.ingest([pet(s)], [s]);
    const old = store.data.records[0]; store.manage('忽略', old.id, '', 'owner');
    store.change(data => {
        for (const [subjectId, scope, name] of [
            ['44444', { kind: 'person' }, '元宝'],
            ['77777', { kind: 'person' }, '豆包'],
            ['33333', { kind: 'group', groupId: '22222' }, '豆包']
        ]) store.addTo(data, { type: 'entity', subjectId, scope, status: 'ignored', content: `宠物${name}`, entity: { name }, source: { quote: `宠物${name}` } });
    });
    service.observe({ self_id: '12345', group_id: '99999', user_id: '33333', message_id: 'fix', message: [] }, '更正：我的豆包其实是一只狗');
    advance(31000); await service.processExtractions();
    assert.deepEqual(captured.suppressedFacts.map(record => record.id), [old.id]);
    assert.equal(captured.knownMemories.length, 0);
    assert.equal(store.data.observations.length, 0);
    assert.equal(store.data.records.at(-1).status, 'pending');
    assert.equal(store.data.records.at(-1).replaces, old.id);
    const context = service.roster.context({ self_id: '12345', group_id: '99999' }, ['33333']);
    assert.ok(store.search(context).every(record => !['ignored', 'deleted'].includes(record.status)));
});

test('提取截断或中断即使JSON合法也保留观察队列，并显式关闭思考', async t => {
    for (const reason of ['length', 'content_filter', undefined]) {
        let captured;
        const result = answer({ memories: [] }, reason);
        if (reason === undefined) delete result.choices[0].finish_reason;
        const { service, store, advance } = fixture(t, { complete: async params => { captured = params; return result; } });
        service.observe({ self_id: '12345', group_id: '99999', user_id: '33333', message_id: 'queued', message: [] }, '我的猫叫豆包');
        advance(31000); await service.processExtractions();
        assert.deepEqual(captured.thinking, { type: 'disabled' });
        assert.equal(store.data.observations.length, 1);
        assert.ok(store.data.observations[0].attempts > 0);
        assert.equal(store.data.records.length, 0);
    }
});

test('摘要截断、中断和本地超长结果均保留原文，不消费摘要队列', async t => {
    for (const result of [answer('用户有猫，但是', 'length'), answer('未完成的摘要', 'content_filter'), answer('长'.repeat(1801))]) {
        let captured;
        const { service, store } = fixture(t, { complete: async params => { captured = params; return result; } });
        const key = '12345:group:99999';
        store.queueSummary(key, [{ role: 'user', content: '我家的猫叫豆包' }, { role: 'assistant', content: '记住啦' }]);
        await service.processSummary(key);
        assert.deepEqual(captured.thinking, { type: 'disabled' });
        assert.equal(store.data.sessions[key].pendingSummary.length, 2);
        assert.equal(store.data.sessions[key].summary, '');
        assert.ok(store.data.sessions[key].summaryRetryAt > 0);
    }
});

test('完成的提取和摘要仍正常提交；旧确认记录与配置不迁移改写', async t => {
    const { service, store, advance } = fixture(t, { complete: async params => params.messages[0].content.includes('记忆提取器')
        ? answer({ memories: [] }) : answer('用户提到自己的猫叫豆包。') });
    service.observe({ self_id: '12345', group_id: '99999', user_id: '33333', message_id: 'queued', message: [] }, '我的猫叫豆包');
    advance(31000); await service.processExtractions();
    assert.equal(store.data.observations.length, 0);
    const key = '12345:group:99999'; store.queueSummary(key, [{ role: 'user', content: '我的猫叫豆包' }]);
    await service.processSummary(key);
    assert.equal(store.data.sessions[key].pendingSummary.length, 0);
    assert.equal(store.data.sessions[key].summary, '用户提到自己的猫叫豆包。');
    const config = { ...store.config };
    store.change(data => store.addTo(data, { type: 'event', subjectId: '33333', scope: { kind: 'group', groupId: '99999' }, content: '旧的已确认事项', status: 'confirmed', source: {} }));
    assert.deepEqual(store.config, config);
    assert.equal(store.data.records.at(-1).status, 'confirmed');
});

test('同句其他人的临时事件只留完整来源，不进入个人正文、跨群召回或提取参考', async t => {
    let payload;
    const { service, store, advance } = fixture(t, { complete: async params => {
        payload = JSON.parse(params.messages.at(-1).content); return answer({ memories: [] });
    } });
    const s = source('我的猫豆包怕水，阿红明天去医院');
    service.ingest([pet(s, { content: '养了一只怕水的猫豆包', evidence: '我的猫豆包怕水',
        entity: { name: '豆包', kind: '猫', relation: '宠物', attributes: '怕水' } })], [s]);
    const record = store.data.records[0];
    assert.equal(record.content, '我的猫豆包怕水');
    assert.equal(record.source.quote, s.text, '完整原话只留存用于审阅');
    assert.equal(record.source.fact, '我的猫豆包怕水');
    service.roster.noteMessage({ self_id: '12345', group_id: '22222', user_id: '33333' });
    const context = service.roster.context({ self_id: '12345', group_id: '22222' }, ['33333']);
    assert.match(store.context(context), /豆包/);
    assert.doesNotMatch(store.context(context), /阿红|医院/);
    service.observe({ self_id: '12345', group_id: '22222', user_id: '33333', message_id: 'cat', message: [] }, '豆包最近怎么样');
    advance(31000); await service.processExtractions();
    assert.equal(payload.knownMemories.length, 1);
    assert.doesNotMatch(JSON.stringify(payload.knownMemories), /阿红|医院/);
});

test('同句多个主体按当前事实各自归属；其他分句中的我不能把别人的宠物借给发言人', t => {
    const { service, store } = fixture(t), s = source('我养了一只猫叫豆包，阿红的狗叫元宝');
    const cat = pet(s, { content: '我养了一只猫叫豆包', entity: { name: '豆包', kind: '猫', relation: '宠物' } });
    const dog = pet(s, { userid: '44444', content: '狗叫元宝', entity: { name: '元宝', kind: '狗', relation: '宠物' }, claim: { field: 'ownership', value: '元宝' } });
    service.ingest([{ ...cat, userid: '44444' }, { ...dog, userid: '33333' }], [s]);
    assert.equal(store.data.records.length, 0);
    service.ingest([cat, dog], [s]);
    assert.deepEqual(store.data.records.map(record => [record.subjectId, record.entity.name]), [['33333', '豆包'], ['44444', '元宝']]);
    assert.doesNotMatch(store.data.records[0].content, /阿红|元宝/);
    assert.doesNotMatch(store.data.records[1].content, /豆包/);
});

test('引语内部的我与引语结束后的我分别属于被转述者和当前发言人', t => {
    const { service, store } = fixture(t), s = source('阿红说：“我养了只猫叫元宝”，我有一只狗叫豆包');
    const cat = pet(s, { userid: '44444', content: '养了只猫叫元宝', entity: { name: '元宝', kind: '猫', relation: '宠物' }, claim: { field: 'ownership', value: '元宝' } });
    const dog = pet(s, { content: '我有一只狗叫豆包', entity: { name: '豆包', kind: '狗', relation: '宠物' } });
    service.ingest([{ ...cat, userid: '33333' }, { ...dog, userid: '44444' }], [s]);
    assert.equal(store.data.records.length, 0);
    service.ingest([cat, dog], [s]);
    assert.deepEqual(store.data.records.map(record => [record.subjectId, record.entity.name]), [['44444', '元宝'], ['33333', '豆包']]);
    assert.equal(store.data.records[0].assertion, 'reported');
    assert.equal(store.data.records[1].assertion, 'affirmed');
});

test('引语跨逗号的命名续句保留被转述者归属，旧无claim宠物输入仍可学习', t => {
    const { service, store } = fixture(t);
    const own = source(); service.ingest([pet(own, { claim: undefined })], [own]);
    assert.equal(store.data.records[0].entity.attributes, '橘猫');
    const quoted = source('阿红说：“我养了一只猫，名字叫元宝”', { id: 's2' });
    service.ingest([pet(quoted, { userid: '44444', content: '猫叫元宝', entity: { name: '元宝', kind: '猫', relation: '宠物' }, claim: undefined })], [quoted]);
    assert.equal(store.data.records[1].subjectId, '44444');
    assert.equal(store.data.records[1].entity.name, '元宝');
});

test('漏填userid的明确自述绑定发言人，真正对象不明的事物保留本会话待绑定', t => {
    const { service, store } = fixture(t), own = source();
    service.ingest([pet(own, { userid: '' })], [own]);
    assert.equal(store.data.records[0].subjectId, '33333');
    assert.deepEqual(store.data.records[0].scope, { kind: 'person' });
    const unknown = source('有人养了一只狗，名字叫元宝', { id: 's2' });
    const dog = pet(unknown, { userid: '', content: '有人养了一只狗叫元宝', entity: { name: '元宝', kind: '狗', relation: '宠物' }, claim: { field: 'ownership', value: '元宝' } });
    service.ingest([{ ...dog, userid: '33333' }], [unknown]);
    assert.equal(store.data.records.length, 1, '不能把不明第三方默认写成发言人');
    service.ingest([dog], [unknown]);
    assert.equal(store.data.records[1].subjectId, '');
    assert.equal(store.data.records[1].scope.kind, 'group');
    assert.equal(store.data.records[1].status, 'pending');
    const inOneClause = source('有人养了一只叫团子的橘猫', { id: 's3' });
    service.ingest([pet(inOneClause, { userid: '', content: inOneClause.text,
        entity: { name: '团子', kind: '猫', relation: '宠物', attributes: '橘猫' }, claim: { field: 'ownership', value: '团子' } })], [inOneClause]);
    assert.equal(store.data.records[2].subjectId, '');
    assert.equal(store.data.records[2].scope.shareWhenBound, true);
});

test('无关前句否定不吞肯定事件，真正条件和后置取消仍阻止活动事项生效', t => {
    const { service, store } = fixture(t);
    const affirmed = source('我不喜欢咖啡，明天去医院');
    const event = s => pet(s, { type: 'event', content: '明天去医院', evidence: '明天去医院', scope: 'group', entity: undefined, claim: { field: 'event', value: '医院' } });
    service.ingest([event(affirmed)], [affirmed]);
    assert.equal(store.data.records[0].status, 'active');
    assert.equal(store.data.records[0].content, '明天去医院');
    for (const text of ['如果有空，明天去医院', '听说，明天去医院', '明天去医院，不过如果下雨就不去', '明天去医院，还是算了', '明天去医院，还没确定', '明天去医院，开玩笑的']) {
        const s = source(text, { id: text }); service.ingest([event(s)], [s]);
    }
    assert.equal(store.data.records.length, 1);
    assert.equal(store.pending().length, 0);
});

test('前一主体的不确定事实不充当后一主体的限定，明确第三方事件仍免确认', t => {
    const { service, store } = fixture(t), s = source('我的猫可能怕水，阿红的狗叫元宝');
    service.ingest([pet(s, { userid: '44444', content: '阿红的狗叫元宝', entity: { name: '元宝', kind: '狗', relation: '宠物' }, claim: { field: 'ownership', value: '元宝' } })], [s]);
    assert.equal(store.data.records[0].content, '阿红的狗叫元宝');
    assert.equal(store.data.records[0].assertion, 'affirmed');
    const next = source('我可能住北京，阿红明天去医院', { id: 's2' });
    service.ingest([pet(next, { type: 'event', userid: '44444', content: '明天去医院', evidence: '阿红明天去医院', scope: 'group', entity: undefined, claim: { field: 'event', value: '医院' } })], [next]);
    assert.equal(store.data.records[1].status, 'active');
    assert.doesNotMatch(store.data.records[1].content, /北京|可能/);
    const scoped = source('如果有空，我明天去医院，阿红的狗叫小白', { id: 's3' });
    service.ingest([pet(scoped, { userid: '44444', content: '阿红的狗叫小白', entity: { name: '小白', kind: '狗', relation: '宠物' }, claim: { field: 'ownership', value: '小白' } })], [scoped]);
    assert.equal(store.data.records[2].content, '阿红的狗叫小白');
    assert.equal(store.data.records[2].scope.kind, 'person');
});

test('涉及其他人的条件事实不提升为跨群稳定事实，条件原话保留在本群参考', t => {
    const { service, store } = fixture(t), s = source('如果阿红有空，我的猫豆包就会出门');
    service.ingest([pet(s, { content: '豆包就会出门', evidence: '我的猫豆包就会出门', entity: { name: '豆包', kind: '猫', relation: '宠物', attributes: '就会出门' } })], [s]);
    assert.equal(store.data.records[0].scope.kind, 'group');
    assert.equal(store.data.records[0].assertion, 'uncertain');
    assert.match(store.data.records[0].content, /如果阿红有空/);
    service.roster.noteMessage({ self_id: '12345', group_id: '22222', user_id: '33333' });
    assert.deepEqual(store.search(service.roster.context({ self_id: '12345', group_id: '22222' }, ['33333'])), []);
});

test('新分句已明确另一宠物时不能把属性继承给旧宠物，真正省略续述仍可保留', t => {
    for (const line of ['我的猫豆包怕水，我的狗元宝爱游泳', '我的猫豆包怕水而我的狗元宝爱游泳']) {
        const { service, store } = fixture(t), s = source(line);
        const wrong = pet(s, { content: '豆包爱游泳', entity: { name: '豆包', kind: '猫', relation: '宠物', attributes: '爱游泳' }, claim: { field: 'trait', value: '爱游泳' } });
        service.ingest([wrong], [s]);
        assert.equal(store.data.records.length, 0);
        service.ingest([{ ...wrong, content: '元宝爱游泳', entity: { name: '元宝', kind: '狗', relation: '宠物', attributes: '爱游泳' } }], [s]);
        assert.equal(store.data.records[0].entity.name, '元宝');
    }
    const { service, store } = fixture(t), s = source('我的猫豆包，喜欢吃鱼，胆子很小');
    service.ingest([pet(s, { content: '豆包胆子很小', entity: { name: '豆包', kind: '猫', relation: '宠物', attributes: '胆子很小' }, claim: { field: 'trait', value: '胆子很小' } })], [s]);
    assert.equal(store.data.records[0].entity.attributes, '胆子很小');
    assert.doesNotMatch(store.data.records[0].content, /喜欢吃鱼/);
});

test('否定实体属性不保留其肯定子串，明确否认所属也不保存宠物关系', t => {
    for (const attributes of ['喜欢吃鱼', '不喜欢吃鱼']) {
        const { service, store } = fixture(t), s = source('我的猫豆包不喜欢吃鱼');
        service.ingest([pet(s, { content: '豆包喜欢吃鱼', evidence: '喜欢吃鱼', entity: { name: '豆包', kind: '猫', relation: '宠物', attributes }, claim: { field: 'preference', value: '鱼' } })], [s]);
        assert.equal(store.data.records[0].assertion, 'negated');
        assert.equal(store.data.records[0].entity.attributes, attributes === '喜欢吃鱼' ? '' : attributes);
        assert.match(store.data.records[0].content, /不喜欢吃鱼/);
    }
    const { service, store } = fixture(t), s = source('这不是我的猫豆包');
    service.ingest([pet(s, { content: '我的猫豆包', entity: { name: '豆包', kind: '猫', relation: '宠物' } })], [s]);
    assert.ok(store.data.records.every(record => record.entity?.relation !== '宠物'), '归属不明可拒绝整项，不能保存肯定的所有权');
});

test('忽略后事实值未变不能凭其实和replaces复活；真正值或极性变化仍可待确认', t => {
    const { service, store } = fixture(t);
    const fact = (s, value, extra = {}) => pet(s, { type: 'fact', content: s.text, entity: undefined, claim: { field: 'residence', value }, ...extra });
    const initial = source('我住北京'); service.ingest([fact(initial, '北京')], [initial]);
    const old = store.data.records[0]; store.manage('忽略', old.id, '', 'owner');
    const same = source('其实我一直住北京', { id: 's2' }); service.ingest([fact(same, '北京', { replaces: old.id })], [same]);
    assert.equal(store.data.records.length, 1);
    const changed = source('更正，我现在住上海', { id: 's3' }); service.ingest([fact(changed, '上海', { replaces: old.id })], [changed]);
    assert.equal(store.data.records[1].status, 'pending');
    assert.equal(store.data.records[0].status, 'ignored');
    const negative = source('我不喜欢咖啡', { id: 's4' });
    const pref = s => pet(s, { type: 'preference', content: s.text, entity: undefined, claim: { field: 'preference', value: '咖啡' } });
    service.ingest([pref(negative)], [negative]); const previous = store.data.records.at(-1); store.manage('忽略', previous.id, '', 'owner');
    const positive = source('我现在喜欢咖啡', { id: 's5' }); service.ingest([{ ...pref(positive), replaces: previous.id }], [positive]);
    assert.equal(store.data.records.at(-1).assertion, 'affirmed');
    assert.equal(store.data.records.at(-1).status, 'pending');
});

test('重复短证据不能借另一人的肯定分句覆盖当前人的否定', t => {
    const { service, store } = fixture(t), s = source('我明天不去医院，阿红明天去医院');
    const event = pet(s, { type: 'event', content: '明天去医院', evidence: '去医院', scope: 'group', entity: undefined, claim: { field: 'event', value: '医院' } });
    service.ingest([event], [s]); assert.equal(store.data.records.length, 0);
    service.ingest([{ ...event, userid: '44444' }], [s]);
    assert.equal(store.data.records[0].subjectId, '44444');
    assert.equal(store.data.records[0].status, 'active');
});

test('共同主体不能作为单人的跨群事实，同名真人的宠物命名不会被误当共同主体', t => {
    const { service, store } = fixture(t);
    for (const text of ['阿红和我一起养豆包', '我和阿红一起养豆包', '我与阿红共同照顾豆包']) {
        const s = source(text, { id: text });
        for (const userid of ['33333', '44444']) service.ingest([pet(s, { userid, content: text,
            entity: { name: '豆包', kind: '', relation: '宠物' } })], [s]);
    }
    assert.equal(store.data.records.length, 0);
    const named = source('我的猫叫阿红');
    service.ingest([pet(named, { content: named.text, entity: { name: '阿红', kind: '猫', relation: '宠物' }, claim: { field: 'ownership', value: '阿红' } })], [named]);
    assert.equal(store.data.records[0].subjectId, '33333');
    assert.equal(store.data.records[0].entity.name, '阿红');
    assert.equal(store.data.records[0].scope.kind, 'person');
});

test('宠物省略回指不能跨越新的明确人物主体，即使新主体仍是原主人', t => {
    for (const middle of ['阿红明天去医院', '我明天去医院']) {
        const { service, store } = fixture(t), s = source(`我的猫豆包怕水，${middle}，喜欢吃鱼`);
        service.ingest([pet(s, { content: '豆包喜欢吃鱼', entity: { name: '豆包', kind: '猫', relation: '宠物', attributes: '喜欢吃鱼' },
            claim: { field: 'trait', value: '喜欢吃鱼' } })], [s]);
        assert.equal(store.data.records.length, 0);
    }
    const { service, store } = fixture(t), s = source('我的猫豆包怕水，胆子很小，喜欢吃鱼');
    service.ingest([pet(s, { content: '豆包喜欢吃鱼', entity: { name: '豆包', kind: '猫', relation: '宠物', attributes: '喜欢吃鱼' },
        claim: { field: 'preference', value: '鱼' } })], [s]);
    assert.equal(store.data.records[0].subjectId, '33333');
    assert.equal(store.data.records[0].entity.attributes, '喜欢吃鱼');
});

test('近期个人偏好和状态保留全部时间限定并留原会话，长期偏好仍可跟人跨群', t => {
    const { service, store } = fixture(t);
    const records = [
        ['我这两天喜欢喝绿茶', 'preference', '喜欢喝绿茶', '绿茶'],
        ['我近两周喜欢喝绿茶', 'preference', '喜欢喝绿茶', '绿茶'],
        ['我暂时住上海', 'fact', '住上海', '上海'],
        ['我目前只喜欢喝绿茶', 'preference', '喜欢喝绿茶', '绿茶']
    ];
    for (const [line, type, content, value] of records) {
        const s = source(line, { id: line });
        service.ingest([pet(s, { type, content, evidence: content, entity: undefined, claim: { field: type === 'fact' ? 'residence' : 'preference', value } })], [s]);
        const record = store.data.records.at(-1);
        assert.equal(record.content, line);
        assert.equal(record.scope.kind, 'group');
    }
    service.roster.noteMessage({ self_id: '12345', group_id: '22222', user_id: '33333' });
    const context = service.roster.context({ self_id: '12345', group_id: '22222' }, ['33333']);
    assert.equal(store.context(context), '');
    const stable = source('我长期喜欢喝绿茶', { id: 'stable' });
    service.ingest([pet(stable, { type: 'preference', content: '喜欢喝绿茶', entity: undefined, claim: { field: 'preference', value: '绿茶' } })], [stable]);
    assert.equal(store.data.records.at(-1).scope.kind, 'person');
    assert.match(store.context(context), /长期喜欢喝绿茶/);
    const unknown = source('有人这两天喜欢喝咖啡', { id: 'unknown-recent' });
    service.ingest([pet(unknown, { type: 'preference', userid: '', content: '喜欢喝咖啡', entity: undefined, claim: { field: 'preference', value: '咖啡' } })], [unknown]);
    const unbound = store.data.records.at(-1); store.manage('确认', unbound.id, '33333', 'owner');
    assert.equal(store.data.records.at(-1).scope.kind, 'group', '补齐主体也不能把明确近期状态提升为全局');
});

test('同一事项的后置取消可隔普通补充分句生效，新主体或独立安排会结束原事项尾部', t => {
    const event = s => pet(s, { type: 'event', content: '明天去医院', evidence: '明天去医院', scope: 'group', entity: undefined,
        claim: { field: 'event', value: '医院' } });
    for (const line of ['我明天去医院，先问问阿红，还是算了', '我明天去医院，先看看天气，如果下雨就不去']) {
        const { service, store } = fixture(t), s = source(line);
        service.ingest([event(s)], [s]);
        assert.equal(store.data.records.length, 0);
        assert.equal(store.pending().length, 0);
    }
    for (const line of ['我明天去医院，阿红明天去图书馆，还是算了', '我明天去医院，先问问阿红，后天去图书馆，还是算了', '我明天去医院，阿红说：“还是算了”']) {
        const { service, store } = fixture(t), s = source(line);
        service.ingest([event(s)], [s]);
        assert.equal(store.data.records[0].status, 'active');
        assert.equal(store.data.records[0].content, '我明天去医院');
    }
});
