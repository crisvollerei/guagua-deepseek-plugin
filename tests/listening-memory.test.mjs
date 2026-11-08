import test from 'node:test';
import assert from 'node:assert/strict';
import { quotedHarness, message, turn, deferred } from './plugin-harness.mjs';
import { FakeClock } from './fake-clock.mjs';
import { ConversationListening } from '../guagua-listen.mjs';

const inputOf = params => JSON.parse(params.messages[1].content);
async function drain(h) {
    for (let i = 0; i < 30; i++) {
        if (h.api.memory.extracting) await turn();
        else if (h.api.memory.store.data.observations.length) await h.api.memory.processExtractions();
        else return;
    }
    assert.fail('隔离记忆提取未完成');
}
const capture = output => params => {
    output.push(inputOf(params));
    return message({ memories: [] });
};

test('silent也可记明确宠物事实，不生成正式回复且不增加一次判断', async t => {
    const clock = new FakeClock(), extracted = [];
    const h = quotedHarness(t, { listeningClock: clock, extraction: params => {
        const input = inputOf(params); extracted.push(input);
        const source = input.messages.find(item => item.text === '我养了只猫叫豆包');
        return message({ memories: source ? [{ type: 'entity', userid: source.speakerId, scope: 'global', assertion: 'affirmed',
            content: '养了只猫叫豆包', entity: { name: '豆包', kind: '猫', relation: '宠物' },
            claim: { field: 'ownership', value: '豆包' }, evidence: source.text, source_id: source.id }] : [] });
    }, judgment: params => {
        const input = inputOf(params);
        return message({ action: 'silent', memory_message_ids: input.messages.map(item => item.id) });
    } });
    await h.instance.chat(h.event('#呱瓜 聊点宠物')); await drain(h); extracted.length = 0;
    await h.instance.accept(h.event('我养了只猫叫豆包'));
    await clock.advance(8000); await drain(h);
    assert.equal(h.calls.length, 1);
    assert.equal(h.judgments.length, 1);
    assert.equal(h.sent.length, 1);
    assert.equal(extracted.flatMap(batch => batch.messages).filter(source => source.text === '我养了只猫叫豆包').length, 1);
    const pet = h.api.memory.store.data.records.find(record => record.entity?.name === '豆包');
    assert.equal(pet.subjectId, '33333');
    assert.equal(pet.source.speakerId, '33333');
    assert.equal(pet.status, 'pending');
    assert.match(h.judgments[0].messages[0].content, /memory_message_ids独立于是否接话/);
});

test('wait分句可连同原上下句独立记忆，已观察前句不重新入队', async t => {
    const clock = new FakeClock(), extracted = [];
    const h = quotedHarness(t, { listeningClock: clock, extraction: capture(extracted), judgment: params => {
        const input = inputOf(params);
        return message({ action: 'wait', memory_message_ids: [...input.previous_messages, ...input.messages].map(item => item.id) });
    } });
    await h.instance.chat(h.event('#呱瓜 聊点宠物')); await drain(h); extracted.length = 0;
    const first = h.event('我最近养了只猫'), second = h.event('它叫豆包');
    await h.instance.accept(first); await clock.advance(8000); await drain(h);
    await h.instance.accept(second); await clock.advance(8000); await drain(h);
    const messages = extracted.flatMap(batch => batch.messages);
    assert.equal(messages.filter(source => source.text === '我最近养了只猫').length, 1);
    const named = messages.filter(source => source.text === '它叫豆包');
    assert.equal(named.length, 1);
    assert.equal(named[0].speakerId, '33333');
    assert.ok(JSON.stringify(named[0]).includes('我最近养了只猫'), '新分句附带原前句作为同人证据参考');
    await clock.advance(20000); await drain(h);
    assert.equal(h.judgments.length, 2);
    assert.equal(h.sent.length, 1);
});

test('记忆选择独立于回复选择，只有memory_message_ids明确选中的前文进入观察', async t => {
    const clock = new FakeClock(), extracted = [];
    const h = quotedHarness(t, { listeningClock: clock, extraction: capture(extracted), judgment: params => {
        const input = inputOf(params);
        return message({ action: 'reply', message_ids: [input.messages.at(-1).id],
            context_message_ids: [input.messages[0].id], memory_message_ids: [input.messages[0].id] });
    } });
    await h.instance.chat(h.event('#呱瓜 开始')); await drain(h); extracted.length = 0;
    await h.instance.accept(h.event('我养的猫叫豆包'));
    await h.instance.accept(h.event('你觉得怎么样'));
    await clock.advance(12000); await drain(h);
    const texts = extracted.flatMap(batch => batch.messages.map(source => source.text));
    assert.ok(texts.includes('我养的猫叫豆包'));
    assert.ok(!texts.includes('你觉得怎么样'));
    assert.equal(h.calls.length, 2);
});

test('silent记忆保留每个实际发言人，引用加入不继承原人的宠物', async t => {
    const clock = new FakeClock(), extracted = [];
    const h = quotedHarness(t, { listeningClock: clock, extraction: capture(extracted), judgment: params => {
        const input = inputOf(params);
        return message({ action: 'silent', memory_message_ids: input.messages.map(item => item.id) });
    } });
    await h.instance.chat(h.event('#呱瓜 开始')); await drain(h); extracted.length = 0;
    await h.instance.accept(h.event('我的猫叫豆包'));
    await h.instance.accept(h.follow('我的狗叫元宝', undefined, { user_id: 44444 }));
    await clock.advance(12000); await drain(h);
    const sources = extracted.flatMap(batch => batch.messages);
    assert.equal(sources.find(source => source.text === '我的猫叫豆包').speakerId, '33333');
    assert.equal(sources.find(source => source.text === '我的狗叫元宝').speakerId, '44444');
    assert.equal(h.calls.length, 1);
});

test('没有窗口、无关成员、其他群和其他插件命令均不进入记忆判断', async t => {
    const clock = new FakeClock(), extracted = [];
    const h = quotedHarness(t, { listeningClock: clock, extraction: capture(extracted) });
    await h.instance.accept(h.event('我的猫叫豆包'));
    await h.instance.chat(h.event('#呱瓜 开始')); await drain(h); extracted.length = 0;
    await h.instance.accept(h.event('我的狗叫元宝', { user_id: 44444 }));
    await h.instance.accept(h.event('我的电脑是台式机', { group_id: 77777 }));
    const command = h.event('#其他插件 我的猫叫豆包');
    assert.equal(await h.instance.accept(command), false);
    await clock.advance(8000); await drain(h);
    assert.equal(h.judgments.length, 0);
    assert.equal(extracted.length, 0);
});

test('伪造memory消息编号和非数组选择不能观察任何消息', async t => {
    for (const ids of [['other-topic:m1'], 'not-an-array']) {
        const clock = new FakeClock(), extracted = [];
        const h = quotedHarness(t, { listeningClock: clock, extraction: capture(extracted), judgment: () => message({ action: 'silent', memory_message_ids: ids }) });
        await h.instance.chat(h.event('#呱瓜 开始')); await drain(h); extracted.length = 0;
        await h.instance.accept(h.event('我的猫叫豆包'));
        await clock.advance(8000); await drain(h);
        assert.equal(extracted.length, 0);
        assert.equal(h.api.conversationListening.sessions.size, 0);
    }
});

test('判断未完成时重置，迟到memory选择不入库也不重新开启窗口', async t => {
    const clock = new FakeClock(), began = deferred(), finish = deferred(), extracted = [];
    const h = quotedHarness(t, { listeningClock: clock, extraction: capture(extracted), judgment: params => { began.resolve(inputOf(params)); return finish.promise; } });
    await h.instance.chat(h.event('#呱瓜 开始')); await drain(h); extracted.length = 0;
    await h.instance.accept(h.event('我的猫叫豆包'));
    const pending = clock.advance(8000), input = await began.promise;
    await h.instance.reset(h.event('#结束对话'));
    finish.resolve(message({ action: 'silent', memory_message_ids: input.messages.map(item => item.id) })); await pending; await drain(h);
    assert.equal(extracted.length, 0);
    assert.equal(h.api.conversationListening.sessions.size, 0);
});

test('引擎wait重判只提交未观察消息，旧选中消息仍作为片段context', async () => {
    const clock = new FakeClock(0), calls = [];
    const listener = new ConversationListening({ now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
        judge: async (_state, batch) => ({ action: 'wait', memoryIds: batch.map(item => item.id) }),
        remember: async (_state, selected, { context }) => { calls.push({ selected: selected.map(item => item.raw), context: context.map(item => item.raw) }); return []; } });
    const state = listener.receive({ scope: 'g', userId: 'A', eventId: '1', raw: '我养了只猫', start: true });
    await clock.advance(8000);
    listener.receive({ scope: 'g', userId: 'A', eventId: '2', raw: '它叫豆包' });
    await clock.advance(8000);
    assert.deepEqual(calls, [{ selected: ['我养了只猫'], context: ['我养了只猫'] }, { selected: ['它叫豆包'], context: ['我养了只猫', '它叫豆包'] }]);
    assert.equal(state.participants.size, 1);
    listener.dispose();
});

test('共享判断期间某人另开话题，过时memory选择不关闭其他参与者的收集', async t => {
    const clock = new FakeClock(), began = deferred(), finish = deferred(), extracted = [];
    const h = quotedHarness(t, { listeningClock: clock, extraction: capture(extracted), judgment: (params, count) => {
        const input = inputOf(params);
        if (count === 1) { began.resolve(input); return finish.promise; }
        return message({ action: 'wait', memory_message_ids: input.messages.map(item => item.id) });
    } });
    await h.instance.chat(h.event('#呱瓜 开始'));
    await h.receive(h.follow('我也加入', undefined, { user_id: 44444 }));
    await drain(h); extracted.length = 0;
    await h.instance.accept(h.event('我的猫叫豆包'));
    await h.instance.accept(h.event('我的狗叫元宝', { user_id: 44444 }));
    const pending = clock.advance(12000), input = await began.promise;
    const replacement = h.instance.chat(h.event('#呱瓜 我另开一个问题'));
    finish.resolve(message({ action: 'wait', memory_message_ids: input.messages.map(item => item.id) }));
    await pending; await replacement;
    await clock.advance(8000); await drain(h);
    assert.equal(h.judgments.length, 2);
    const sources = extracted.flatMap(batch => batch.messages);
    assert.equal(sources.filter(source => source.text === '我的猫叫豆包').length, 0);
    assert.equal(sources.filter(source => source.text === '我的狗叫元宝' && source.speakerId === '44444').length, 1);
});

test('显式命令在观察前被补充打断，promote后的有用原话仍可独立入记忆', async t => {
    const clock = new FakeClock(), began = deferred(), finish = deferred(), extracted = [];
    const h = quotedHarness(t, { listeningClock: clock, extraction: capture(extracted), judgment: params => {
        const input = inputOf(params);
        return message({ action: 'wait', memory_message_ids: input.messages.filter(item => item.text.includes('养了只猫')).map(item => item.id) });
    } });
    const first = h.instance.chat(h.event('#呱瓜 我养了只猫叫豆包', { reply_id: 'context-msg',
        getReply: async () => { began.resolve(); return finish.promise; } }));
    await began.promise;
    await h.instance.accept(h.event('等下，我还想补充'));
    finish.resolve({ user_id: 44444, message_id: 'context-msg', message: [{ type: 'text', text: '只是一段引用背景' }] });
    await first;
    assert.equal(h.calls.length, 0);
    assert.equal(extracted.length, 0);
    await clock.advance(8000); await drain(h);
    const sources = extracted.flatMap(batch => batch.messages);
    assert.equal(sources.filter(source => source.text === '我养了只猫叫豆包' && source.speakerId === '33333').length, 1);
    assert.equal(h.calls.length, 0);
    assert.equal(h.sent.length, 0);
});

test('remember异步返回前有新补充，已选历史事实保留但不按旧快照回复或清空新消息', async () => {
    const clock = new FakeClock(0), began = deferred(), finish = deferred(), intake = [];
    let replies = 0;
    const listener = new ConversationListening({ now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
        judge: async (_state, batch) => ({ action: 'reply', ids: batch.map(item => item.id), memoryIds: batch.map(item => item.id) }),
        remember: async (_state, selected, { context }) => {
            intake.push({ selected: selected.map(item => item.raw), context: context.map(item => item.raw) });
            if (intake.length === 1) { began.resolve(); await finish.promise; }
            return [];
        }, reply: async () => { replies++; } });
    const state = listener.receive({ scope: 'g', userId: 'A', eventId: '1', raw: '我养了只猫', start: true });
    const pending = clock.advance(8000); await began.promise;
    listener.receive({ scope: 'g', userId: 'A', eventId: '2', raw: '它叫豆包' });
    finish.resolve(); await pending;
    assert.equal(state.handledSeq, 0);
    assert.equal(state.messages.length, 2);
    assert.equal(replies, 0);
    await clock.advance(8000);
    assert.equal(replies, 1);
    assert.deepEqual(intake[1], { selected: ['它叫豆包'], context: ['我养了只猫', '它叫豆包'] });
    assert.equal(state.messages.length, 0);
    listener.dispose();
});

test('promoted引用记忆请求即使模型silent且memory为空也按原作者核实收录', async t => {
    const clock = new FakeClock(), began = deferred(), finish = deferred(), extracted = [];
    const h = quotedHarness(t, { listeningClock: clock, extraction: capture(extracted),
        judgment: () => message({ action: 'silent', memory_message_ids: [] }) });
    const e = h.event('#呱瓜 记住这条', { reply_id: 'original-fact',
        getReply: async () => { began.resolve(); return finish.promise; } });
    e.bot.gml = new Map([[99999, new Map([[33333, {}], [44444, { nickname: '原作者' }]])]]);
    const pending = h.instance.chat(e); await began.promise;
    await h.instance.accept(h.event('等一下，不用回复我'));
    finish.resolve({ user_id: 44444, message_id: 'original-fact', time: Math.floor(Date.now() / 1000),
        sender: { nickname: '原作者' }, message: [{ type: 'text', text: '我养了只猫叫元宝' }] });
    await pending;
    await clock.advance(8000); await drain(h);
    const sources = extracted.flatMap(batch => batch.messages), quoted = sources.find(source => source.text === '我养了只猫叫元宝');
    assert.equal(quoted.speakerId, '44444');
    assert.equal(quoted.quoted, true);
    assert.equal(h.calls.length, 0);
    assert.equal(h.sent.length, 0);
    const judged = inputOf(h.judgments[0]).messages.find(item => item.explicit_memory_request);
    assert.equal(judged.has_quote, true);
    assert.match(judged.text, /记住这条/);
});

test('真实主chat后silent养猫再silent命名，已处理前句作为证据合成正确待确认实体', async t => {
    const clock = new FakeClock(), extracted = [];
    const h = quotedHarness(t, { listeningClock: clock, extraction: params => {
        const input = inputOf(params); extracted.push(input);
        const source = input.messages.find(item => item.text === '它叫豆包');
        if (!source) return message({ memories: [] });
        const before = source.references.find(item => item.text === '我最近养了只猫');
        assert.ok(before);
        return message({ memories: [{ source_id: source.id,
            evidence_parts: [{ source_id: before.id, text: before.text }, { source_id: source.id, text: source.text }],
            type: 'entity', userid: source.speakerId, scope: 'global', assertion: 'affirmed', content: '猫叫豆包',
            entity: { name: '豆包', kind: '猫', relation: '宠物' }, claim: { field: 'ownership', value: '豆包' } }] });
    }, judgment: params => {
        const input = inputOf(params);
        return message({ action: 'silent', memory_message_ids: [...input.previous_messages, ...input.messages].map(item => item.id) });
    } });
    await h.instance.chat(h.event('#呱瓜 聊点宠物')); await drain(h); extracted.length = 0;
    await h.instance.accept(h.event('我最近养了只猫')); await clock.advance(8000); await drain(h);
    await h.instance.accept(h.event('它叫豆包')); await clock.advance(8000); await drain(h);
    const pet = h.api.memory.store.data.records.find(record => record.entity?.name === '豆包');
    assert.ok(pet);
    assert.equal(pet.subjectId, '33333');
    assert.equal(pet.entity.kind, '猫');
    assert.equal(pet.status, 'pending');
    assert.equal(pet.source.fragments.length, 2);
    assert.ok(pet.source.fragments.every(fragment => fragment.speakerId === '33333'));
    assert.equal(extracted.flatMap(batch => batch.messages).filter(source => source.text === '我最近养了只猫').length, 1);
    assert.equal(h.sent.length, 1);
    assert.equal(h.calls.length, 1);
    assert.equal(h.judgments.length, 2);
});
