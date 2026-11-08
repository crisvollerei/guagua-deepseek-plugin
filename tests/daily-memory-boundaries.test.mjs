import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MemoryService } from '../guagua-memory.mjs';

const DAY = 86400000;
function fixture(t) {
    const base = path.resolve('tests/.tmp'); fs.mkdirSync(base, { recursive: true });
    const directory = fs.mkdtempSync(path.join(base, 'daily-boundary-'));
    let time = Date.parse('2026-11-08T06:00:00Z');
    const service = new MemoryService({ directory, now: () => time,
        logger: { info() {}, warn() {}, error() {} },
        getProfile: () => ({ users: { '33333': { name: '阿明' }, '44444': { name: '阿红' } }, pending: [] }),
        complete: async () => ({ choices: [{ finish_reason: 'stop', message: { content: '{"memories":[]}' } }] }) });
    service.roster.noteMessage({ self_id: '12345', group_id: '99999', user_id: '33333' });
    t.after(() => {
        service.dispose();
        assert.equal(path.dirname(path.resolve(directory)), base);
        assert.ok(path.basename(directory).startsWith('daily-boundary-'));
        fs.rmSync(directory, { recursive: true, force: true });
    });
    const source = (id, text, overrides = {}) => ({ id, session: '12345:group:99999', botId: '12345',
        speakerId: '33333', groupId: '99999', name: '阿明', at: new Date(time).toISOString(), text, targets: [], ...overrides });
    const context = query => ({ ...service.roster.context({ self_id: '12345', group_id: '99999', user_id: '33333' }, ['33333']), query });
    return { service, store: service.store, source, context, now: () => time, advance: ms => { time += ms; } };
}

const event = (source, overrides = {}) => ({ type: 'event', userid: '33333', scope: 'group', content: source.text,
    assertion: 'affirmed', claim: { field: 'event', value: '医院' }, source_id: source.id, evidence: source.text, ...overrides });

test('不同日再次说同一句明天安排会分成两次事项，不覆盖原日期和来源', t => {
    const f = fixture(t), first = f.source('first-day', '我明天去医院');
    f.service.ingest([event(first)], [first]);
    f.advance(DAY);
    const next = f.source('second-day', '我明天去医院');
    f.service.ingest([event(next)], [next]);
    assert.equal(f.store.data.records.length, 2);
    assert.equal(f.store.data.records[0].source.messageId, first.id);
    assert.equal(f.store.data.records[1].source.messageId, next.id);
    assert.notEqual(f.store.data.records[0].expiresAt, f.store.data.records[1].expiresAt);
});

test('再次提到同句安排不能复活已经办完的旧事项', t => {
    const f = fixture(t), first = f.source('first-day', '我明天去医院');
    f.service.ingest([event(first)], [first]);
    const oldId = f.store.data.records[0].id;
    const done = f.source('done', '我在医院的检查已经完成了');
    f.service.ingest([event(done, { operation: 'complete', target_id: oldId })], [done]);
    assert.equal(f.store.data.records[0].status, 'completed');
    f.advance(DAY);
    const next = f.source('next-day', '我明天去医院');
    f.service.ingest([event(next)], [next]);
    assert.equal(f.store.data.records.length, 2);
    assert.equal(f.store.data.records[0].status, 'completed');
    assert.equal(f.store.data.records[1].status, 'active');
    assert.notEqual(f.store.data.records[1].id, oldId);
});
const trait = (source, name, kind, parts) => ({ type: 'entity', userid: '33333', scope: 'global', assertion: 'affirmed',
    content: name + '胆子很小', entity: { name, kind, relation: '宠物', attributes: '胆子很小' },
    claim: { field: 'trait', value: '胆子很小' }, source_id: source.id, evidence: source.text,
    evidence_parts: parts.map(part => ({ source_id: part.id, text: part.text })) });

test('单项近场取消不能把明确机票事项借给医院安排', t => {
    const h = fixture(t), original = h.source('hospital', '我明天去医院');
    h.service.ingest([event(original)], [original]);
    const hospital = h.store.data.records[0];
    h.advance(60000);
    const cancellation = h.source('ticket', '我的机票取消了');
    h.service.ingest([event(cancellation, { assertion: 'negated', claim: { field: 'event', value: '机票' } })], [cancellation]);
    assert.equal(hospital.status, 'active');
    assert.equal(hospital.endSource, undefined);
});

test('题词相同但明确日期不同的取消不结束原来的明天安排', t => {
    const h = fixture(t), original = h.source('tomorrow', '我明天去医院');
    h.service.ingest([event(original)], [original]);
    const hospital = h.store.data.records[0];
    h.advance(60000);
    const cancellation = h.source('after-tomorrow', '我后天去医院的安排取消了');
    h.service.ingest([event(cancellation, { assertion: 'negated' })], [cancellation]);
    assert.equal(hospital.status, 'active');
    assert.equal(hospital.endSource, undefined);
});

test('群知识标签不能让已知个人事实绕过当前群人物资格', t => {
    const h = fixture(t), source = h.source('group-person', '本群阿红住北京');
    h.service.ingest([event(source, { type: 'fact', userid: '', subject_kind: 'group', scope: 'global',
        claim: { field: 'residence', value: '北京' } })], [source]);
    assert.equal(h.store.data.records.length, 0);
    assert.doesNotMatch(h.service.context(h.context('阿红住哪里')), /阿红住北京/);
});

test('分条证据不能跳过同批中间明确的新宠物，把属性借回之前的猫', t => {
    const h = fixture(t), cat = h.source('cat', '我的猫叫豆包');
    h.advance(1000); const dog = h.source('dog', '另外我的狗叫元宝');
    h.advance(1000); const continuation = h.source('trait', '它胆子很小');
    const sources = [cat, dog, continuation];
    h.service.ingest([trait(continuation, '豆包', '猫', [cat, continuation])], sources);
    assert.ok(h.store.data.records.every(record => record.entity?.name !== '豆包' || record.entity?.attributes !== '胆子很小'));
    h.service.ingest([trait(continuation, '元宝', '狗', [dog, continuation])], sources);
    assert.ok(h.store.data.records.some(record => record.entity?.name === '元宝' && record.entity?.attributes === '胆子很小'));
});

test('最近两天与最近三天的复述保留新时限，不只延长旧正文的到期时间', t => {
    const h = fixture(t);
    const preference = source => event(source, { type: 'preference', scope: 'global', claim: { field: 'preference', value: '绿茶' } });
    const first = h.source('pref-2', '我最近两天喜欢喝绿茶');
    h.service.ingest([preference(first)], [first]);
    h.advance(60000);
    const second = h.source('pref-3', '我最近三天喜欢喝绿茶');
    h.service.ingest([preference(second)], [second]);
    const recent = h.store.data.records.find(record => record.content.includes('最近三天'));
    assert.ok(recent, '新的时限必须出现在可召回的正文，不能只留在evidenceTrail');
    assert.match(recent.source.fact, /最近三天/);
    assert.equal(recent.scope.kind, 'group');
    assert.ok(Date.parse(recent.expiresAt) >= h.now() + 2 * DAY);
    assert.match(h.service.context(h.context('喜欢喝什么')), /最近三天/);
});

test('取消提问和明确否认取消均不结束原有安排', t => {
    const h = fixture(t), original = h.source('hospital', '我明天去医院');
    h.service.ingest([event(original)], [original]);
    const hospital = h.store.data.records[0];
    for (const [id, text, assertion] of [
        ['cancel-question', '明天去医院的安排要取消吗？', 'uncertain'],
        ['not-cancelled', '明天去医院的安排没有取消', 'negated']
    ]) {
        h.advance(60000);
        const next = h.source(id, text);
        h.service.ingest([event(next, { assertion })], [next]);
        assert.equal(hospital.status, 'active', text);
        assert.equal(hospital.endSource, undefined);
    }
});
