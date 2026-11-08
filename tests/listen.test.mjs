import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationListening } from '../guagua-listen.mjs';
import { FakeClock } from './fake-clock.mjs';
import { QuotedContinuation } from '../guagua-reply.mjs';

function setup(options = {}) {
    const clock = new FakeClock(), calls = [], replies = [], errors = [];
    const listener = new ConversationListening({ now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
        judge: async (_state, batch) => { calls.push({ at: clock.now(), batch }); return { action: 'reply', ids: batch.map(message => message.id) }; },
        reply: async (_state, batch) => replies.push(batch), onError: error => errors.push(error), ...options });
    let seq = 0;
    const input = (overrides = {}) => ({ scope: 'bot:group:one', userId: '1', eventId: `m${++seq}`, raw: '普通补充', ...overrides });
    const begin = (overrides = {}) => listener.receive(input({ start: true, raw: '#呱瓜', ...overrides }));
    return { clock, listener, calls, replies, errors, input, begin };
}

test('没有明确入口时普通消息和昵称都不能自行创建收集窗口', async () => {
    const h = setup();
    for (const raw of ['呱瓜', '笨瓜', '大笨瓜说话', '为什么你这么麻烦']) {
        assert.equal(h.listener.receive(h.input({ raw, wake: true })), null);
    }
    await h.clock.advance(70000);
    assert.equal(h.calls.length, 0);
    assert.equal(h.listener.sessions.size, 0);
});

test('空指令统一等待判断，没有两秒固定问候；判断后保留短暂话题', async () => {
    const h = setup(), state = h.begin();
    await h.clock.advance(2000);
    assert.equal(h.calls.length, 0);
    assert.equal(h.replies.length, 0);
    await h.clock.advance(6000);
    assert.equal(h.calls.length, 1);
    assert.equal(h.replies.length, 1);
    assert.equal(h.listener.byUser(state.scope, '1'), state);
    await h.clock.advance(52000);
    assert.equal(h.listener.sessions.size, 0);
});

test('参与者续发按八四二秒最多延长两次，十四秒判断且原文都在', async () => {
    const h = setup(), start = h.clock.now();
    h.begin();
    await h.clock.advance(1000);
    h.listener.receive(h.input({ raw: '先说一半' }));
    await h.clock.advance(7000); assert.equal(h.calls.length, 0);
    await h.clock.advance(3000);
    h.listener.receive(h.input({ raw: '再补一段' }));
    await h.clock.advance(1000); assert.equal(h.calls.length, 0);
    await h.clock.advance(1000);
    h.listener.receive(h.input({ raw: '最后一段' }));
    await h.clock.advance(1000);
    assert.equal(h.calls[0].at - start, 14000);
    assert.deepEqual(h.calls[0].batch.map(message => message.raw), ['#呱瓜', '先说一半', '再补一段', '最后一段']);
});

test('静默后仍可无关键词补充，先前消息保留给下一次判断参考', async () => {
    const seen = [];
    const h = setup({ judge: async (state, batch) => {
        seen.push({ batch: batch.map(m => m.raw), recent: state.recent.map(m => m.raw) });
        return { action: 'silent' };
    } });
    h.begin({ raw: '为什么你这么麻烦' });
    await h.clock.advance(8000);
    assert.equal(h.listener.sessions.size, 1);
    h.listener.receive(h.input({ raw: '你倒是说话呀' }));
    await h.clock.advance(8000);
    assert.deepEqual(seen[1], { batch: ['你倒是说话呀'], recent: ['为什么你这么麻烦', '你倒是说话呀'] });
    assert.equal(h.replies.length, 0);
});

test('继续等待无新消息不重复判断，收到补充才再判断且保留原文', async () => {
    const batches = [];
    const h = setup({ judge: async (_state, batch) => { batches.push(batch.map(m => m.raw)); return { action: 'wait' }; } });
    h.begin({ raw: '等一下，我还没说完' });
    await h.clock.advance(20000);
    assert.equal(batches.length, 1);
    h.listener.receive(h.input({ raw: '补充好了' }));
    await h.clock.advance(8000);
    assert.deepEqual(batches[1], ['等一下，我还没说完', '补充好了']);
    await h.clock.advance(40000);
    assert.equal(batches.length, 2);
    assert.equal(h.listener.sessions.size, 0);
});

test('无关成员和其他群不收集，有效引用加入后保留自己的身份', async () => {
    const h = setup(), state = h.begin();
    const window = {}; state.window = window;
    assert.equal(h.listener.receive(h.input({ userId: '2' })), null);
    assert.equal(h.listener.receive(h.input({ scope: 'other:group' })), null);
    h.listener.receive(h.input({ userId: '2', reference: { window }, raw: '我也有个问题' }));
    await h.clock.advance(12000);
    assert.deepEqual(h.calls[0].batch.map(message => message.userId), ['1', '2']);
});

test('新回复刷新六十秒窗口，普通静默消息不无限续期', async () => {
    const h = setup({ judge: async () => ({ action: 'silent' }) }), state = h.begin();
    await h.clock.advance(8000);
    await h.clock.advance(40000);
    h.listener.open({ state, scope: state.scope, userId: '1', history: [{ role: 'assistant', content: '已回答' }] });
    await h.clock.advance(50000);
    h.listener.receive(h.input());
    await h.clock.advance(8000);
    assert.equal(h.listener.sessions.size, 1);
    await h.clock.advance(2000);
    assert.equal(h.listener.sessions.size, 0);
});

test('明确结束关闭本话题，重复投递、重置、卸载和资格变化不遗留定时器', async () => {
    const h = setup({ judge: async () => ({ action: 'end' }) });
    const e = h.input({ start: true }); h.listener.receive(e); h.listener.receive(e);
    assert.equal(h.listener.sessions.values().next().value.messages.length, 1);
    await h.clock.advance(8000);
    assert.equal(h.listener.sessions.size, 0);
    h.begin(); h.listener.invalidate(e.scope); await h.clock.advance(70000);
    assert.equal(h.clock.timers.size, 0);
    h.begin(); h.listener.dispose(); assert.equal(h.clock.timers.size, 0);
    const expired = setup({ current: () => false });
    assert.equal(expired.begin(), null);
    assert.equal(expired.listener.sessions.size, 0);
});

test('无效判断和伪造消息编号停止本轮，不自动重试', async () => {
    for (const result of [{ action: 'unknown' }, { action: 'reply', ids: ['forged'] }]) {
        const h = setup({ judge: async () => result });
        h.begin(); await h.clock.advance(70000);
        assert.equal(h.errors.length, 1); assert.equal(h.replies.length, 0);
        assert.equal(h.listener.sessions.size, 0); assert.equal(h.clock.timers.size, 0);
    }
});

test('判断或生成期间的新补充会与旧消息重新合并，不按过时结果清空消息', async () => {
    for (const phase of ['judge', 'reply']) {
        let release, began;
        const waiting = new Promise(resolve => { release = resolve; });
        const started = new Promise(resolve => { began = resolve; });
        const batches = [];
        const h = setup({ judge: async (_state, batch) => {
            batches.push(batch.map(message => message.raw));
            if (phase === 'judge' && batches.length === 1) { began(); await waiting; }
            return { action: 'reply', ids: batch.map(message => message.id) };
        }, reply: async () => { if (phase === 'reply' && batches.length === 1) { began(); await waiting; } } });
        h.begin({ raw: '原来的问题' });
        const pending = h.clock.advance(8000); await started;
        h.listener.receive(h.input({ raw: '现在又补充了' }));
        release(); await pending;
        await h.clock.advance(8000);
        assert.deepEqual(batches, [['原来的问题'], ['原来的问题', '现在又补充了']]);
        assert.equal(h.listener.sessions.size, 1);
    }
});

test('旧回答迟到不覆盖同成员后来明确开启的新话题', () => {
    const h = setup(), old = h.begin();
    h.listener.stop(old);
    const current = h.begin({ raw: '新的话题' });
    assert.equal(h.listener.open({ state: old, scope: old.scope, userId: '1', history: [{ role: 'assistant', content: '旧回答' }] }), null);
    assert.equal(h.listener.byUser(old.scope, '1'), current);
    assert.deepEqual(current.history, []);
});

test('不能用其他群或机器人账号的活动状态开启当前话题', () => {
    const h = setup(), state = h.begin();
    for (const scope of ['bot:group:two', 'another-bot:group:one']) {
        assert.equal(h.listener.open({ state, scope, userId: '2' }), null);
        assert.equal(h.listener.byUser(scope, '2'), null);
    }
    assert.deepEqual([...state.participants], ['1']);
});

test('引用租约在等待和重判保留，静默、单人退出、到期、错误和卸载均释放', async () => {
    for (const outcome of ['silent', 'leave', 'expire', 'error', 'dispose']) {
        const h = setup({ judge: async () => ({ action: 'wait' }) });
        const manager = new QuotedContinuation({ now: h.clock.now });
        const window = manager.record('bot:group:one', { turnId: 'root', token: { key: 'g', epoch: 0 }, receipt: { message_id: 'answer' }, text: '回答', history: [] });
        const state = h.listener.open({ scope: 'bot:group:one', userId: '1', window });
        const reference = manager.claim(state.scope, 'answer', 'claim');
        h.listener.receive(h.input({ reference }));
        await h.clock.advance(8000);
        assert.equal(window.pending, 1, outcome);
        if (outcome === 'leave') h.listener.stopForUser(state.scope, '1');
        else if (outcome === 'expire') await h.clock.advance(52000);
        else if (outcome === 'dispose') h.listener.dispose();
        else {
            h.listener.judge = async () => { if (outcome === 'error') throw Error('临时错误'); return { action: 'silent' }; };
            h.listener.receive(h.input({ raw: '新的补充' }));
            assert.equal(window.pending, 2);
            await h.clock.advance(8000);
        }
        assert.equal(window.pending, 0, outcome);
        reference.release();
        assert.equal(window.pending, 0, outcome);
        h.listener.dispose();
    }
});

test('焦点过期或退出后不自行回退到另一个旧话题，清理旧话题不抢新焦点', () => {
    const h = setup(), scope = 'bot:group:one';
    const old = h.listener.open({ scope, userId: '1' });
    const current = h.listener.open({ scope, userId: '1' });
    h.listener.stop(old);
    assert.equal(h.listener.byUser(scope, '1'), current);
    h.clock.time = current.expiresAt;
    assert.equal(h.listener.byUser(scope, '1'), null);
    h.listener.stop(current);
    assert.equal(h.listener.focus.size, 0);
});

test('短期图片使用回执裁剪结果，无回执编号时同样有容量边界', () => {
    const h = setup(), state = h.begin(), raw = [{ src: 'A'.repeat(13 * 1024 * 1024), speakerId: 'A' }];
    h.listener.recordReply(state, { history: [], userId: '1', images: raw });
    assert.equal(state.images[0].src, undefined);
    assert.match(state.images[0].unavailableReason, /容量/);
    const window = { images: [{ speakerId: 'A', unavailable: true, unavailableReason: '已由回执缓存裁剪' }] };
    h.listener.recordReply(state, { window, history: [], userId: '1', images: raw });
    assert.equal(state.images, window.images);
    assert.equal(state.images[0].src, undefined);
    for (const id of ['2', '3', '4']) {
        const other = h.listener.open({ scope: state.scope, userId: id });
        h.listener.recordReply(other, { history: [], userId: id, images: [{ src: id.repeat(11 * 1024 * 1024) }] });
        assert.equal(Boolean(other.images[0].src), id !== '4');
    }
    h.listener.dispose();
});
