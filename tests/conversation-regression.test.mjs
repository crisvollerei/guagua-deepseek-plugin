import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationListening } from '../guagua-listen.mjs';
import { FakeClock } from './fake-clock.mjs';
import { quotedHarness, message, deferred, turn } from './plugin-harness.mjs';
import { sessionKey } from '../guagua-memory.mjs';

const replyAll = params => {
    const input = JSON.parse(params.messages[1].content);
    return message({ action: 'reply', message_ids: input.messages.map(item => item.id), target_id: input.messages.at(-1).speaker_id });
};
const textOf = payload => Array.isArray(payload) ? payload.join('') : payload;
// 计时器发起异步工作后，仍允许时钟向前走，模拟真实网络请求尚未返回。
async function elapse(clock, ms, tasks) {
    const until = clock.time + ms;
    for (;;) {
        const next = [...clock.timers.values()].filter(timer => timer.at <= until).sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!next) break;
        clock.time = next.at;
        clock.timers.delete(next.id);
        tasks.push(Promise.resolve(next.task()));
        await turn();
    }
    clock.time = until;
    await turn();
}

test('批次中逐条引用保留原回答和原回应对象，不拿最新回答替代旧引用', async t => {
    const clock = new FakeClock();
    const h = quotedHarness(t, { listeningClock: clock,
        response: (_params, count) => message(['甲的猫豆包的回答', '乙的狗元宝的回答', '第三次回答'][count - 1]),
        judgment: params => {
            const input = JSON.parse(params.messages[1].content);
            const selected = input.messages.find(item => item.speaker_id === '55555');
            assert.equal(selected.reference.text, '甲的猫豆包的回答');
            assert.equal(selected.reference.reply_to_userid, '33333');
            return message({ action: 'reply', message_ids: [selected.id], target_id: '55555' });
        } });
    await h.instance.chat(h.event('#呱瓜 甲的猫豆包怎么养'));
    const catId = h.sent.at(-1).receipt.message_id;
    await h.receive(h.follow('我的狗元宝怎么养', catId, { user_id: 44444, sender: { nickname: '乙' } }));
    await h.instance.accept(h.event('我再补充一点'));
    await h.instance.accept(h.follow('这个该吃什么', catId, { user_id: 55555, sender: { nickname: '丙' } }));
    await clock.advance(12000);
    const actual = h.calls[2];
    assert.match(actual.messages[0].content, /被引用回答当时回应的成员：userid=33333/);
    assert.match(actual.messages.at(-1).content, /本条明确引用的机器人回答（当时回应userid=33333）：.*甲的猫豆包的回答/s);
    assert.doesNotMatch(actual.messages.at(-1).content, /乙的狗元宝的回答/);
});

test('发送中收到补充，成功回执仍提交历史和引用，余下消息取消且下轮知道已发送部分', async t => {
    const clock = new FakeClock(), began = deferred(), finish = deferred();
    const h = quotedHarness(t, { listeningClock: clock,
        response: (_params, count) => count === 1 ? message('起始回答') : message({ reply_format: 'guagua-v1', mode: 'chat', messages: ['已发出的第一段', '不应发出的第二段'] }),
        judgment: (params, count) => {
            if (count === 1) return replyAll(params);
            const input = JSON.parse(params.messages[1].content);
            assert.ok(input.context.some(item => item.content.includes('已发出的第一段')));
            return message({ action: 'end', target_id: '33333' });
        } });
    await h.instance.chat(h.event('#呱瓜 开始'));
    const e = h.event('原来的后续问题', { reply: async () => { began.resolve(); return finish.promise; } });
    await h.instance.accept(e);
    const pending = clock.advance(8000); await began.promise;
    await h.instance.accept(h.event('发送期间的新补充'));
    finish.resolve(true); await pending;
    assert.deepEqual(h.sent.map(item => textOf(item.payload)), ['起始回答', '已发出的第一段']);
    assert.ok(h.api.memory.store.history(sessionKey(e), 3).some(item => item.role === 'assistant' && item.content === '已发出的第一段'));
    const sentId = h.sent.at(-1).receipt.message_id;
    assert.ok(h.api.quoteContinuations.find(sessionKey(e), sentId));
    await clock.advance(8000);
    assert.equal(h.judgments.length, 2);
    assert.equal(h.api.conversationListening.sessions.size, 0);
});

test('网络发送已经开始后重置，迟到回执不会重建历史或引用资格', async t => {
    const began = deferred(), finish = deferred();
    const h = quotedHarness(t);
    const e = h.event('#呱瓜 旧问题', { reply: async () => { began.resolve(); return finish.promise; } });
    const pending = h.instance.chat(e); await began.promise;
    await h.instance.reset(h.event('#结束对话'));
    finish.resolve(true); await pending;
    assert.deepEqual(h.api.memory.store.history(sessionKey(e), 3), []);
    assert.equal(h.api.quoteContinuations.windows.size, 0);
    assert.equal(h.api.conversationListening.sessions.size, 0);
});

test('明确命令和直接引用生成中收到收尾，旧回答都会取消并保留原问题供统一重判', async t => {
    for (const entry of ['command', 'quote']) {
        const clock = new FakeClock(), began = deferred(), finish = deferred();
        const h = quotedHarness(t, { listeningClock: clock,
            response: (_params, count) => {
                if (entry === 'quote' && count === 1) return message('先前的回答');
                began.resolve(); return finish.promise;
            }, judgment: params => {
                const input = JSON.parse(params.messages[1].content);
                assert.ok(input.messages.some(item => item.text.includes('原来的问题')));
                assert.ok(input.messages.some(item => item.text.includes('算了')));
                return message({ action: 'end', target_id: '33333' });
            } });
        let pending;
        if (entry === 'command') pending = h.instance.chat(h.event('#呱瓜 原来的问题'));
        else {
            await h.instance.chat(h.event('#呱瓜 起始问题'));
            await h.instance.accept(h.follow('原来的问题'));
            pending = h.api.memory.chains.get(sessionKey(h.event()));
        }
        await began.promise;
        await h.instance.accept(h.event('算了，不用回答了'));
        finish.resolve(message('不应出现的旧回答')); await pending; await turn();
        assert.doesNotMatch(JSON.stringify(h.sent), /不应出现的旧回答/);
        await clock.advance(8000);
        assert.equal(h.judgments.length, 1);
        assert.equal(h.api.conversationListening.sessions.size, 0);
    }
});

test('构造思考转发时重置，不发送迟到思考或正文', async t => {
    const began = deferred(), finish = deferred();
    const h = quotedHarness(t, { config: { 'deepseekJS:thinking_enabled': 'true', 'deepseekJS:forwardMsg': '2' },
        response: () => { const result = message('正式回答'); result.choices[0].message.reasoning_content = '旧思考'; return result; },
        forward: async () => { began.resolve(); return finish.promise; } });
    const pending = h.instance.chat(h.event('#呱瓜 旧问题')); await began.promise;
    await h.instance.reset(h.event('#结束对话'));
    finish.resolve({ type: 'forward', nodes: ['旧思考'] }); await pending;
    assert.doesNotMatch(JSON.stringify(h.sent), /旧思考|正式回答/);
});

test('60秒准入绝对截止，连续补充不会无限重判，最后已收快照仍可完成', async () => {
    const clock = new FakeClock(0); let listener, judgments = 0, replies = 0;
    listener = new ConversationListening({ now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
        judge: async (state, batch) => {
            judgments++;
            listener.receive({ scope: state.scope, userId: 'A', eventId: 'new-' + judgments, raw: '判断期间的补充' });
            return { action: 'reply', ids: batch.map(message => message.id) };
        }, reply: async () => { replies++; } });
    const state = listener.receive({ scope: 'b:group:g', userId: 'A', eventId: 'entry', raw: '#呱瓜', start: true });
    await clock.advance(128000);
    assert.equal(state.expiresAt, 60000);
    assert.equal(listener.receive({ scope: state.scope, userId: 'A', raw: '到期后的普通消息' }), null);
    assert.equal(replies, 1);
    assert.ok(judgments <= 8);
    assert.equal(listener.sessions.size, 0);
    listener.dispose();
});

test('单人另开问题只移除本人，迟到回执不重新加入退出者', () => {
    const clock = new FakeClock(0);
    const listener = new ConversationListening({ now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
    const window = {}, state = listener.open({ scope: 'b:group:g', userId: 'A', window });
    listener.receive({ scope: state.scope, userId: 'B', eventId: 'join', reference: { window }, raw: '我的问题' });
    listener.stopForUser(state.scope, 'A');
    assert.equal(listener.byUser(state.scope, 'A'), null);
    assert.equal(listener.byUser(state.scope, 'B'), state);
    listener.recordReply(state, { userId: 'A', window, history: [{ role: 'assistant', content: '已发出的旧段落' }] });
    assert.equal(listener.byUser(state.scope, 'A'), null);
    assert.equal(listener.byUser(state.scope, 'B'), state);
    assert.deepEqual(state.messages.map(message => message.userId), ['B']);
    listener.dispose();
});

test('共享话题中一个人说结束，其他人的本批问题继续处理', async t => {
    const clock = new FakeClock();
    const h = quotedHarness(t, { listeningClock: clock, judgment: (params, count) => count === 1
        ? message({ action: 'end', target_id: '33333' })
        : replyAll(params) });
    await h.instance.chat(h.event('#呱瓜 起始问题'));
    await h.receive(h.follow('我也加入', undefined, { user_id: 44444 }));
    await h.instance.accept(h.event('算了，不聊了'));
    await h.instance.accept(h.event('我的问题还没说完', { user_id: 44444 }));
    await clock.advance(12000);
    assert.equal(h.api.conversationListening.byUser(sessionKey(h.event()), '33333'), null);
    assert.ok(h.api.conversationListening.byUser(sessionKey(h.event()), '44444'));
    await clock.advance(8000);
    assert.equal(h.judgments.length, 2);
    const second = JSON.parse(h.judgments[1].messages[1].content);
    assert.deepEqual(second.messages.map(item => item.speaker_id), ['44444']);
    assert.equal(h.calls.length, 3);
});

test('已准入的接话生成超过90秒，原引用不再准入但新回执仍可引用', async t => {
    const clock = new FakeClock(), began = deferred(), finish = deferred();
    let now = 0;
    const h = quotedHarness(t, { listeningClock: clock, judgment: replyAll,
        response: (_params, count) => count === 1 ? message('起始回答') : (began.resolve(), finish.promise) });
    h.api.quoteContinuations.now = () => now;
    await h.instance.chat(h.event('#呱瓜 起始问题'));
    const originalId = h.sent.at(-1).receipt.message_id;
    await h.instance.accept(h.event('补充的问题'));
    const pending = clock.advance(8000); await began.promise;
    now = 91000;
    assert.equal(h.api.quoteContinuations.find(sessionKey(h.event()), originalId), null);
    finish.resolve(message('超过90秒才完成的回答')); await pending;
    const receipt = h.sent.at(-1).receipt.message_id;
    assert.ok(h.api.quoteContinuations.find(sessionKey(h.event()), receipt));
    assert.equal([...h.api.quoteContinuations.windows.values()][0].pending, 0);
});

test('有效引用排在同群另一话题后，超过引用期限仍完成已准入请求', async t => {
    const began = deferred(), finish = deferred(); let now = 0;
    const h = quotedHarness(t, { response: (_params, count) => count === 2
        ? (began.resolve(), finish.promise) : message(count === 1 ? '甲的原回答' : '甲的引用回答') });
    h.api.quoteContinuations.now = () => now;
    await h.instance.chat(h.event('#呱瓜 甲的问题'));
    const originalId = h.sent.at(-1).receipt.message_id;
    const other = h.instance.chat(h.event('#呱瓜 乙的另一话题', { user_id: 44444 }));
    await began.promise;
    await h.instance.accept(h.follow('甲的追问', originalId));
    const queued = h.api.memory.chains.get(sessionKey(h.event()));
    now = 91000;
    assert.equal(h.api.quoteContinuations.find(sessionKey(h.event()), originalId), null);
    finish.resolve(message('乙的回答')); await other; await queued;
    assert.equal(h.calls.length, 3);
    assert.equal(textOf(h.sent.at(-1).payload), '甲的引用回答');
    assert.ok(h.api.quoteContinuations.find(sessionKey(h.event()), h.sent.at(-1).receipt.message_id));
});

test('引用加入旧批次后普通补充跟随该成员焦点，别人引用其他话题不抢焦点', async t => {
    const clock = new FakeClock(0), h = quotedHarness(t, { listeningClock: clock });
    await h.instance.chat(h.event('#呱瓜 乙的狗问题', { user_id: 44444 }));
    const dogId = h.sent.at(-1).receipt.message_id, dog = [...h.api.conversationListening.sessions.values()][0];
    await h.instance.chat(h.event('#呱瓜 甲的猫问题'));
    const catId = h.sent.at(-1).receipt.message_id, cat = [...h.api.conversationListening.sessions.values()].at(-1);
    await h.instance.accept(h.event('狗的问题我补充一下', { user_id: 44444 }));
    await h.instance.accept(h.follow('接乙的狗这个话题', dogId));
    await h.instance.accept(h.event('它刚才又吐了'));
    assert.ok(dog.messages.some(item => item.raw === '它刚才又吐了'));
    assert.equal(cat.messages.length, 0);
    await h.receive(h.follow('丙接甲的猫话题', catId, { user_id: 55555 }));
    assert.equal(h.api.conversationListening.byUser(sessionKey(h.event()), '33333'), dog);
    await h.instance.accept(h.event('它现在好些了'));
    assert.ok(dog.messages.some(item => item.raw === '它现在好些了'));
    assert.equal(h.api.conversationListening.byUser(sessionKey(h.event()), '55555'), cat);
});

test('第59秒引用加入收集也获得完整60秒期限，普通消息仍不续期', async t => {
    const clock = new FakeClock(0), h = quotedHarness(t, { listeningClock: clock });
    await h.instance.chat(h.event('#呱瓜 乙的问题', { user_id: 44444 }));
    const id = h.sent.at(-1).receipt.message_id, state = [...h.api.conversationListening.sessions.values()][0];
    await clock.advance(59000);
    await h.instance.accept(h.event('再补充一句', { user_id: 44444 }));
    await h.instance.accept(h.follow('我现在加入这个话题', id));
    assert.equal(state.expiresAt, 119000);
    await clock.advance(1500);
    await h.instance.accept(h.event('这是我紧接着的补充'));
    assert.equal(state.expiresAt, 119000);
    assert.ok(state.messages.some(item => item.raw === '这是我紧接着的补充'));
});

test('第89秒合并认领覆盖判断和重判，过90秒仍保留新回答引用且全部释放', async t => {
    const clock = new FakeClock(0), began = deferred(), finish = deferred(), tasks = [];
    const h = quotedHarness(t, { listeningClock: clock, judgment: (params, count) => {
        if (count === 1) { began.resolve(JSON.parse(params.messages[1].content).messages); return finish.promise; }
        return replyAll(params);
    } });
    h.api.quoteContinuations.now = clock.now;
    await h.instance.chat(h.event('#呱瓜 起始问题'));
    const original = h.sent.at(-1).receipt.message_id, state = [...h.api.conversationListening.sessions.values()][0], window = state.window;
    await elapse(clock, 57000, tasks);
    await h.instance.accept(h.event('原来的后续问题'));
    await elapse(clock, 8000, tasks); const first = await began.promise;
    await elapse(clock, 24000, tasks);
    const quote = h.follow('第89秒认领的引用追问', original);
    await h.instance.accept(quote);
    assert.equal(state.expiresAt, 149000);
    assert.equal(window.pending, 2);
    await h.instance.accept(quote);
    assert.equal(window.pending, 2);
    await elapse(clock, 1001, tasks);
    assert.equal(h.api.quoteContinuations.find(sessionKey(quote), original), null);
    assert.equal(h.api.quoteContinuations.windows.get(window.key), window);
    finish.resolve(message({ action: 'reply', message_ids: first.map(item => item.id), target_id: '33333' }));
    await Promise.all(tasks);
    await elapse(clock, 8000, tasks); await Promise.all(tasks);
    assert.equal(h.calls.length, 2);
    assert.ok(h.api.quoteContinuations.find(sessionKey(quote), h.sent.at(-1).receipt.message_id));
    assert.equal(window.pending, 0);
});

test('直接引用被取消并转入批次后租约继续持有，结束或重置均释放', async t => {
    for (const end of ['end', 'reset']) {
        const clock = new FakeClock(), began = deferred(), finish = deferred();
        const h = quotedHarness(t, { listeningClock: clock, response: (_params, count) => count === 1 ? message('先前回答') : (began.resolve(), finish.promise),
            judgment: () => message({ action: 'end', target_id: '33333' }) });
        await h.instance.chat(h.event('#呱瓜 开始'));
        const window = [...h.api.quoteContinuations.windows.values()][0];
        await h.instance.accept(h.follow('被打断的引用追问')); await began.promise;
        const pending = h.api.memory.chains.get(sessionKey(h.event()));
        await h.instance.accept(h.event('算了，不用回答'));
        finish.resolve(message('不应发送')); await pending; await turn();
        assert.equal(window.pending, 2);
        if (end === 'reset') await h.instance.reset(h.event('#结束对话'));
        else await clock.advance(8000);
        assert.equal(window.pending, 0);
        assert.doesNotMatch(JSON.stringify(h.sent), /不应发送/);
    }
});

test('首条回执前到达的补充在窗口创建后补租约，长判断后新回答仍可引用', async t => {
    const clock = new FakeClock(), sendBegan = deferred(), sendFinish = deferred(), judgeBegan = deferred(), judgeFinish = deferred();
    let quoteTime = 0;
    const h = quotedHarness(t, { listeningClock: clock, judgment: params => { judgeBegan.resolve(params); return judgeFinish.promise; } });
    h.api.quoteContinuations.now = () => quoteTime;
    const first = h.instance.chat(h.event('#呱瓜 原问', { reply: async () => { sendBegan.resolve(); return sendFinish.promise; } }));
    await sendBegan.promise;
    await h.instance.accept(h.event('首条回执前的补充'));
    const state = [...h.api.conversationListening.sessions.values()][0];
    assert.equal(state.window, null);
    sendFinish.resolve(true); await first;
    const window = state.window;
    assert.equal(window.pending, 2);
    const pending = clock.advance(8000), params = await judgeBegan.promise;
    quoteTime = 91000;
    h.api.quoteContinuations.prune();
    assert.equal(h.api.quoteContinuations.windows.get(window.key), window);
    judgeFinish.resolve(replyAll(params)); await pending;
    assert.ok(h.api.quoteContinuations.find(sessionKey(h.event()), h.sent.at(-1).receipt.message_id));
    assert.equal(window.pending, 0);
});
