import test from 'node:test';
import assert from 'node:assert/strict';
import { quotedHarness, pluginHarness, message, turn, deferred } from './plugin-harness.mjs';
import { sessionKey } from '../guagua-memory.mjs';
import { FakeClock } from './fake-clock.mjs';

async function drain(service) {
    for (let i = 0; i < 50; i++) {
        if (service.extracting) await turn();
        else if (service.store.data.observations.length) await service.processExtractions();
        else return;
    }
    assert.fail('memory extraction did not drain');
}
function roster(e, ids = [33333, 44444]) {
    e.bot.gml = new Map([[99999, new Map(ids.map(id => [id, { user_id: id, nickname: `成员${id}` }]))]]);
    return e;
}
function quotedPet(e, { time = 1794110400, user = 44444, group = 99999 } = {}) {
    e.reply_id = 'pet-original';
    e.getReply = async () => ({ user_id: user, group_id: group, message_id: 'pet-original', time,
        sender: { user_id: user, nickname: '原作者' }, message: [{ type: 'text', text: '我养了一只猫叫豆包' }] });
    return e;
}

test('历史回应对象作为独立路由信息，旧标记不再作为助手正文，回声不会发出', async t => {
    const h = quotedHarness(t, { response: (_params, count) => message(count === 1 ? '原回答' :
        '【机器人回应的发言人：userid=44444】\n是你说的那件事呀。') });
    const e = h.event('#呱瓜 原话');
    await h.instance.chat(e);
    const window = h.api.quoteContinuations.find(sessionKey(e), h.sent[0].receipt.message_id);
    window.history.at(-1).content = '【机器人回应的发言人：userid=33333】\n原回答';
    delete window.history.at(-1).replyToUserId;
    await h.receive(h.follow('修的是你啊', undefined, { user_id: 44444 }));
    const request = h.calls[1];
    assert.ok(request.messages.some(m => m.role === 'assistant' && m.content === '原回答'));
    assert.ok(request.messages.filter(m => m.role === 'assistant').every(m => !m.content.includes('机器人回应的发言人')));
    assert.match(request.messages[0].content, /"reply_to_userid":"33333"/);
    assert.match(request.messages.at(-1).content, /userid:44444/);
    assert.doesNotMatch(JSON.stringify(h.sent), /机器人回应的发言人/);
    const stored = h.api.memory.store.history(sessionKey(e), 3).filter(m => m.role === 'assistant');
    assert.ok(stored.every(m => !m.content.includes('机器人回应的发言人')));
    assert.equal(stored.at(-1).replyToUserId, '44444');
    assert.equal(window.history.at(-1).replyToUserId, '44444');
});

test('明确要求记住被引用原话时，以原作者和原时间收录，不归到请求者', async t => {
    const batches = [];
    const h = pluginHarness(t, { extraction: params => {
        const sources = JSON.parse(params.messages[1].content).messages;
        batches.push(sources);
        return message({ memories: sources.filter(s => s.text === '我养了一只猫叫豆包').map(s => ({
            type: 'entity', userid: s.speakerId, content: s.text, scope: 'global', assertion: 'affirmed',
            claim: { field: 'ownership', value: '豆包' }, entity: { name: '豆包', kind: '猫', relation: '宠物' },
            evidence: s.text, source_id: s.id
        })) });
    } });
    const e = quotedPet(roster(h.event('#呱瓜 请记住这条')));
    await h.instance.chat(e); await drain(h.api.memory);
    const record = h.api.memory.store.data.records.find(r => r.entity?.name === '豆包');
    assert.ok(record);
    assert.equal(record.subjectId, '44444');
    assert.equal(record.source.speakerId, '44444');
    assert.equal(record.source.at, new Date(1794110400 * 1000).toISOString());
    assert.match(record.source.messageId, /pet-original$/);
    assert.equal(record.status, 'pending');
    assert.ok(batches.some(batch => batch.some(s => s.text === '请记住这条') && batch.some(s => s.text === '我养了一只猫叫豆包')));
});

for (const [name, content, options, ids] of [
    ['普通看图引用', '#呱瓜 你看看', {}, [33333, 44444]],
    ['否定收录请求', '#呱瓜 别记住这条', {}, [33333, 44444]],
    ['先要求再撤销收录', '#呱瓜 记住这条？不，别记了', {}, [33333, 44444]],
    ['已不在群的原作者', '#呱瓜 记住这条', {}, [33333]],
    ['其他群的引用', '#呱瓜 记住这条', { group: 88888 }, [33333, 44444]],
    ['机器人自己的引用', '#呱瓜 记住这条', { user: 12345 }, [12345, 33333, 44444]]
]) test(`${name}不会触发原作者记忆收录`, async t => {
    const observed = [];
    const h = pluginHarness(t, { extraction: params => {
        observed.push(...JSON.parse(params.messages[1].content).messages);
        return message({ memories: [] });
    } });
    await h.instance.chat(quotedPet(roster(h.event(content), ids), options));
    await drain(h.api.memory);
    assert.ok(observed.every(source => source.text !== '我养了一只猫叫豆包'));
});

for (const mode of ['1', '2']) test(`开启思考展示方式${mode}也不会输出内部回应对象标记`, async t => {
    const h = pluginHarness(t, { config: { 'deepseekJS:thinking_enabled': 'true', 'deepseekJS:forwardMsg': mode },
        forward: nodes => ({ type: 'forward', nodes }), response: () => ({ choices: [{ finish_reason: 'stop',
            message: { role: 'assistant', content: '正式回答', reasoning_content: '【机器人回应的发言人：userid=44444】\n推理内容' } }] }) });
    await h.instance.chat(h.event('#呱瓜 修的是你啊'));
    assert.doesNotMatch(JSON.stringify(h.replies), /机器人回应的发言人/);
    assert.match(JSON.stringify(h.replies), /推理内容/);
    assert.match(JSON.stringify(h.replies), /正式回答/);
});

test('缺少原时间的引用仍可记稳定事实，同时保留时间未知标识', async t => {
    let source;
    const h = pluginHarness(t, { extraction: params => {
        source = JSON.parse(params.messages[1].content).messages.find(s => s.text === '我养了一只猫叫豆包');
        return message({ memories: [] });
    } });
    await h.instance.chat(quotedPet(roster(h.event('#呱瓜 记住这条')), { time: null }));
    await drain(h.api.memory);
    assert.equal(source?.originalTimeUnknown, true);
    assert.equal(source.speakerId, '44444');
});

test('记住引用的命令在读取前被补充打断，静默重判仍能以原作者补记', async t => {
    const clock = new FakeClock(), began = deferred(), finish = deferred(), observed = [];
    const h = quotedHarness(t, { listeningClock: clock, extraction: params => {
        observed.push(...JSON.parse(params.messages[1].content).messages);
        return message({ memories: [] });
    }, judgment: params => {
        const input = JSON.parse(params.messages[1].content);
        return message({ action: 'silent', memory_message_ids: input.messages.filter(m => m.text.includes('记住这条')).map(m => m.id) });
    } });
    const e = quotedPet(roster(h.event('#呱瓜 记住这条'))), original = await e.getReply();
    let reads = 0;
    e.getReply = async () => { if (++reads === 1) { began.resolve(); return finish.promise; } return original; };
    const pending = h.instance.chat(e); await began.promise;
    await h.instance.accept(h.event('等下，我还想补充'));
    finish.resolve(original); await pending;
    await clock.advance(8000); await drain(h.api.memory);
    assert.equal(h.calls.length, 0);
    assert.equal(h.sent.length, 0);
    const facts = observed.filter(source => source.text === '我养了一只猫叫豆包');
    assert.equal(facts.length, 1);
    assert.equal(facts[0].speakerId, '44444');
    assert.equal(facts[0].at, new Date(1794110400 * 1000).toISOString());
});
