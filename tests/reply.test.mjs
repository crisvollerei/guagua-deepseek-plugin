import test from 'node:test';
import assert from 'node:assert/strict';
import { ReplyDelivery, QuotedContinuation, planReply, markdownSections, prefersSingleReply } from '../guagua-reply.mjs';

const envelope = (messages, mode = 'chat') => ({ reply_format: 'guagua-v1', mode, messages });
const sender = options => new ReplyDelivery({ sleep: async () => {}, random: () => 0, ...options });

test('模型决定自然停顿，普通短回复与用户所需JSON保持原样', () => {
    assert.deepEqual(planReply(JSON.stringify(envelope(['先说这一句', '再补充一个问题？']))).messages, ['先说这一句', '再补充一个问题？']);
    assert.deepEqual(planReply('你好呀，今天怎么样？').messages, ['你好呀，今天怎么样？']);
    assert.deepEqual(planReply('{"name":"用户要求的JSON"}').messages, ['{"name":"用户要求的JSON"}']);
    assert.deepEqual(planReply('```json\n{"answer":42}\n```').messages, ['```json\n{"answer":42}\n```']);
});

test('分段发送保留用词、语气与自然收尾，不追加消息或去除真正的提问', async () => {
    for (const messages of [
        ['哎呀，又被你逮到了～(￣▽￣)'],
        ['笨瓜在这儿呢～', '这回可没躲着你。'],
        ['嗯，问题出在这里。', '把这个条件补上就好啦～'],
        ['这里有两种情况。', '你用的是哪一种？']
    ]) {
        const sent = [], delivery = sender(), state = delivery.create(planReply(envelope(messages)));
        await delivery.send(state, { send: async text => { sent.push(text); return { message_id: `sent-${sent.length}` }; } });
        assert.deepEqual(sent, messages);
        assert.deepEqual(state.history, messages);
    }
});

test('模型直接返回多段纯文本时，按自然段兜底为多条消息', () => {
    const first = '先把这个问题处理好。', second = '另外，后面的事情我们可以慢慢来。';
    for (const separator of ['\n\n', '\r\n\r\n']) {
        assert.deepEqual(planReply(first + separator + second).messages, [first, second]);
    }
    assert.deepEqual(planReply('好呀\n我先帮你看看。\n另外，再确认一下这个地方。').messages, ['好呀', '我先帮你看看。', '另外，再确认一下这个地方。']);
});

test('messages同一项中的多个自然段仍可分次发送，已有分条边界也保留', () => {
    assert.deepEqual(planReply(envelope(['先说这一句。\n\n另外再补充一个问题？'])).messages, ['先说这一句。', '另外再补充一个问题？']);
    assert.deepEqual(planReply(envelope(['第一段。\n\n第二段。', '第三段。'])).messages, ['第一段。', '第二段。', '第三段。']);
});

test('段落兜底不按标点切同一段，也不会把句子中途的换行当成独立消息', () => {
    assert.deepEqual(planReply('一句。第二句！第三句？').messages, ['一句。第二句！第三句？']);
    assert.deepEqual(planReply('这一句话还没有\n说完。').messages, ['这一句话还没有\n说完。']);
});

test('明确单条请求优先于新增的自然段兜底', () => {
    const text = '第一段。\n\n第二段。';
    assert.deepEqual(planReply(text, { single: true }).messages, [text]);
    assert.deepEqual(planReply(envelope([text], 'single')).messages, [text]);
});

test('自然段兜底保留短列表、表格、引用以及代码前的说明', () => {
    for (const text of [
        '两步就好：\n\n1. 打开设置\n\n2. 保存修改',
        '| A | B |\n| --- | --- |\n\n| 1 | 2 |',
        '> 引用的第一段。\n\n> 引用的第二段。',
        '代码如下：\n\n```js\nconst a = 1;\n\nconsole.log(a);\n```',
        '{\n  "first": "原样JSON",\n\n  "second": "仍是JSON"\n}',
        '请查看[文档][doc]。\n\n[doc]: https://example.com/doc'
    ]) assert.deepEqual(planReply(text).messages, [text]);
});

test('长短不均的多个片段合并后不会全部坍缩成一条', () => {
    const messages = ['好呀', '先等等', '我再确认一下', '是这样的', '具体解释。'.repeat(40)];
    const result = planReply(envelope(messages));
    assert.ok(result.messages.length >= 2);
    assert.ok(result.messages.length <= 3);
    assert.equal(result.messages.join('\n'), messages.join('\n'));
    const paragraphResult = planReply(messages.join('\n\n'));
    assert.ok(paragraphResult.messages.length >= 2);
    assert.equal(paragraphResult.messages.join('\n').replace(/\n/g, ''), messages.join(''));
});

test('内部格式兼容外层代码围栏，损坏控制格式不直接显示给用户', () => {
    assert.deepEqual(planReply('```json\n' + JSON.stringify(envelope(['正常内容'])) + '\n```').messages, ['正常内容']);
    assert.throws(() => planReply('{"mode":"chat","reply_format":"guagua-v1","messages":['), /格式不完整/);
    assert.throws(() => planReply({ ...envelope(['内容']), mode: 'unknown' }), /方式无效/);
});

test('非空但字段类型损坏的结构化回复不能悄悄变成空消息', () => {
    for (const messages of ['有内容却不是数组', [{ text: '对象中的正文' }], ['正常部分', null]]) {
        assert.throws(() => planReply({ reply_format: 'guagua-v1', mode: 'chat', messages }), /格式|字符串/);
    }
});

test('用户要求单条时保留完整长内容，不按字数切割或改为转发', () => {
    const content = '详细说明。'.repeat(300);
    assert.equal(planReply(envelope([content, '完整结尾']), { single: true }).mode, 'single');
    assert.deepEqual(planReply(envelope([content], 'single')).messages, [content]);
    assert.ok(prefersSingleReply('这次别分条回复，详细解释一下'));
    assert.ok(prefersSingleReply('解释这个问题，只发一条'));
    assert.ok(!prefersSingleReply('为什么“别分条”有时没有生效？'));
});

test('模型过度拆碎时合并相邻内容，不丢弃句子、不强制凑足条数', () => {
    const messages = Array.from({ length: 9 }, (_, i) => `意思${i}。`);
    const result = planReply(envelope(messages));
    assert.ok(result.messages.length <= 3);
    assert.equal(result.messages.join('\n'), messages.join('\n'));
    assert.equal(planReply(envelope(['一句就够'])).messages.length, 1);
});

test('完整代码块、Markdown链接、URL和表格不能被拆在不同消息里', () => {
    const code = planReply(envelope(['```js', 'const answer = 42;', '```', '解释一下上面的代码']));
    assert.equal(code.messages[0], '```js\nconst answer = 42;\n```');
    assert.deepEqual(planReply(envelope(['看[这里](', 'https://example.com/doc)'])).messages, ['看[这里](https://example.com/doc)']);
    assert.deepEqual(planReply(envelope(['https://example.com/doc', '?page=2'])).messages, ['https://example.com/doc?page=2']);
    assert.equal(planReply(envelope(['| A | B |\n| --- | --- |', '| 1 | 2 |'])).messages.length, 1);
});

test('长教程自动选择转发，短列表不会仅因模型选择forward就转发', () => {
    const long = Array.from({ length: 6 }, (_, i) => `第${i}部分\n${'完整解释。'.repeat(30)}`).join('\n\n');
    const result = planReply(long);
    assert.equal(result.mode, 'forward');
    assert.equal(result.sections.join('\n\n'), long);
    const short = planReply({ reply_format: 'guagua-v1', mode: 'forward', intro: '两步就好', sections: ['先打开设置', '然后保存'] });
    assert.equal(short.mode, 'chat');
    assert.equal(short.messages.join('\n'), '两步就好\n先打开设置\n然后保存');
});

test('转发分节点保留代码块中的空行、缩进及完整段落', () => {
    const code = '```python\ndef f():\n\n    return 42\n```';
    assert.deepEqual(markdownSections(`说明\n\n${code}\n\n结束`), ['说明', code, '结束']);
    assert.equal(planReply(envelope(['    const indented = true;'])).messages[0], '    const indented = true;');
});

test('第一条立即发送，后续有短停顿，仅第一条引用原消息', async () => {
    const events = [], progress = [];
    const delivery = sender({ sleep: async ms => events.push({ pause: ms }) });
    const state = delivery.create(planReply(envelope(['先说这一句', '再补充一下'])));
    await delivery.send(state, { send: async (text, quote) => { events.push({ text, quote }); return true; }, onProgress: () => progress.push(state.history.join('|')) });
    assert.deepEqual(events[0], { text: '先说这一句', quote: true });
    assert.equal(events.filter(e => e.pause).reduce((sum, e) => sum + e.pause, 0), 600);
    assert.deepEqual(events.at(-1), { text: '再补充一下', quote: false });
    assert.deepEqual(progress, ['先说这一句', '先说这一句|再补充一下']);
});

test('第二条失败后保留首条进度，续发不会重复成功内容', async () => {
    const delivery = sender(), state = delivery.create(planReply(envelope(['第一条', '第二条', '第三条'])));
    const sent = []; let fail = true;
    const options = { send: async text => { if (text === '第二条' && fail) return false; sent.push(text); return true; } };
    await assert.rejects(delivery.send(state, options), /发送未成功/);
    assert.deepEqual(state.history, ['第一条']);
    assert.equal(state.next, 1);
    fail = false;
    await delivery.send(state, options);
    assert.deepEqual(sent, ['第一条', '第二条', '第三条']);
});

test('失败包装结果也不提交进度，单次重试仅重发失败项', async () => {
    const delivery = sender(), state = delivery.create(planReply(envelope(['第一条', '第二条'])));
    const tried = []; let fails = 0;
    await delivery.send(state, { attempts: 2, send: async text => { tried.push(text); return text === '第二条' && fails++ === 0 ? { error: 'failed' } : { message_id: 'ok' }; } });
    assert.deepEqual(tried, ['第一条', '第二条', '第二条']);
    assert.deepEqual(state.history, ['第一条', '第二条']);
});

test('等待期间取消只保留已经发送的部分，剩余消息立即停止', async () => {
    let valid = true;
    const delivery = sender({ sleep: async () => { valid = false; } });
    const state = delivery.create(planReply(envelope(['已经说的', '尚未说的'])));
    const sent = [];
    assert.equal(await delivery.send(state, { valid: () => valid, send: async text => { sent.push(text); return true; } }), false);
    assert.deepEqual(sent, ['已经说的']);
    assert.deepEqual(state.history, ['已经说的']);
});

test('长篇先发引言再发合并转发，内部格式不会出现在正文和历史里', async () => {
    const delivery = sender();
    const sections = ['解释内容。'.repeat(100), '完整结尾'];
    const state = delivery.create(planReply({ reply_format: 'guagua-v1', mode: 'forward', intro: '主要原因是第二点', sections }));
    const sent = [];
    await delivery.send(state, { makeForward: async nodes => ({ type: 'forward', nodes }), send: async (payload, quote) => { sent.push({ payload, quote }); return true; } });
    assert.deepEqual(sent[0], { payload: '主要原因是第二点', quote: true });
    assert.equal(sent[1].payload.type, 'forward');
    assert.equal(sent[1].quote, false);
    assert.ok(state.history.join('\n').includes('完整结尾'));
    assert.ok(!state.history.join('\n').includes('reply_format'));
});

test('转发不受支持或构造失败时回退到少量完整段落，保留全部内容', async () => {
    for (const makeForward of [async () => { throw Error('unsupported'); }, async () => '普通文本', async () => []]) {
        const delivery = sender(), content = Array.from({ length: 6 }, (_, i) => `段落${i} ${'说明。'.repeat(60)}`).join('\n\n');
        const state = delivery.create(planReply(content)), sent = [];
        await delivery.send(state, { makeForward, send: async text => { sent.push(text); return true; } });
        assert.ok(sent.length <= 3);
        assert.equal(sent.join('\n').replace(/\n/g, ''), content.replace(/\n/g, ''));
    }
});

test('转发发送失败后只补发卡片，不重复引言', async () => {
    const delivery = sender(), state = delivery.create(planReply('正文。'.repeat(400)));
    let fail = true, builds = 0;
    const sent = [], options = { makeForward: async nodes => { builds++; return { type: 'forward', nodes }; }, send: async payload => {
        if (typeof payload === 'object' && fail) return { status: 'failed' };
        sent.push(payload); return true;
    } };
    await assert.rejects(delivery.send(state, options), /发送未成功/);
    assert.equal(state.history.length, 1);
    fail = false; await delivery.send(state, options);
    assert.equal(builds, 1);
    assert.equal(sent.length, 2);
});

test('转发构造期间取消时不会先发送一条失去正文的引言', async () => {
    const delivery = sender(), state = delivery.create(planReply('正文。'.repeat(400)));
    let active = true, sends = 0;
    assert.equal(await delivery.send(state, { valid: () => active, makeForward: async () => { active = false; return { type: 'forward' }; }, send: async () => { sends++; } }), false);
    assert.equal(sends, 0);
});

test('发送进度提供实际成功回执，失败尝试不登记引用资格', async () => {
    const delivery = sender(), state = delivery.create(planReply(envelope(['第一条', '第二条'])));
    const progress = []; let count = 0;
    await delivery.send(state, { attempts: 2, send: async () => ++count === 1 ? false : { message_id: count },
        onProgress: (value, receipt) => progress.push({ parts: value.history.length, id: receipt.message_id }) });
    assert.deepEqual(progress, [{ parts: 1, id: 2 }, { parts: 2, id: 3 }]);
});

test('引用窗口只认成功回执，按实际回复续期，重复消息不重复认领', () => {
    let time = 1000;
    const manager = new QuotedContinuation({ now: () => time }), token = { key: 'bot:group:1', epoch: 0 };
    const options = { turnId: 'turn', token, text: '回复', history: [{ role: 'assistant', content: '回复' }] };
    assert.equal(manager.record('one', { ...options, receipt: true }), null);
    assert.equal(manager.record('one', { ...options, receipt: { error: 'fail', message_id: 'failed' } }), null);
    const window = manager.record('one', { ...options, receipt: { data: { message_id: ['a', 'b'] } } });
    assert.equal(manager.claim('two', 'a'), null);
    assert.equal(manager.claim('one', 'failed'), null);
    const incoming = manager.claim('one', 'b', 'incoming');
    assert.equal(incoming.duplicate, false);
    assert.equal(manager.claim('one', 'b', 'incoming').duplicate, true);
    assert.equal(window.pending, 1);
    incoming.release(); incoming.release();
    assert.equal(window.pending, 0);
    time += 89999;
    assert.equal(manager.get(window.key), window);
    time++;
    assert.equal(manager.get(window.key), null);
});

test('生成期间到期只停止新认领，成功发送仍可续期；同群不同话题互不覆盖', () => {
    let time = 1000;
    const manager = new QuotedContinuation({ now: () => time, limit: 2 }), token = { key: 'bot:group:1', epoch: 0 };
    const options = { token, history: [], text: '回复' };
    const window = manager.record('one', { ...options, turnId: 'first', receipt: { message_id: 'a' } });
    window.pending++;
    time += 90001;
    assert.equal(manager.get(window.key), null);
    assert.equal(manager.record('one', { ...options, turnId: 'followup', window, receipt: { message_id: 'b' } }), window);
    window.pending--;
    manager.claim('one', 'a').release();
    manager.record('one', { ...options, turnId: 'new-topic', receipt: { message_id: 'c' } });
    manager.claim('one', 'a').release();
    manager.claim('one', 'c').release();
    assert.equal(manager.record('two', { ...options, turnId: 'late', window, receipt: { message_id: 'd' } }), null);
    for (const key of ['two', 'three']) manager.record(key, { ...options, turnId: key, receipt: { message_id: key } });
    assert.equal(manager.windows.size, 2);
    assert.equal(manager.get(window.key), null);
});

test('同一话题的每条回执分别保留回应对象，换人接话不覆盖旧回答的对象', () => {
    const manager = new QuotedContinuation(), token = { key: 'bot:group:one', epoch: 0 };
    const window = manager.record('group', { turnId: 'root', token, receipt: { message_id: 'answer-a' },
        text: '对甲的回答', history: [], userId: '11111', userName: '甲' });
    manager.record('group', { turnId: 'follow', token, window, receipt: { message_id: 'answer-b' },
        text: '对乙的回答', history: [], userId: '22222', userName: '乙' });
    const original = manager.claim('group', 'answer-a'), latest = manager.claim('group', 'answer-b');
    assert.equal(original.window, latest.window);
    assert.equal(original.replyToUserId, '11111');
    assert.equal(original.replyToName, '甲');
    assert.equal(original.quotedText, '对甲的回答');
    assert.equal(latest.replyToUserId, '22222');
    assert.equal(latest.quotedText, '对乙的回答');
    assert.equal(manager.claim('other-group', 'answer-a'), null);
    original.release(); latest.release();
});

test('认领租约保护过期及容量回收，重复释放不减成负数', () => {
    let time = 0;
    const manager = new QuotedContinuation({ now: () => time, limit: 1 });
    const token = { key: 'g', epoch: 0 }, opts = { token, history: [], text: '正文' };
    const window = manager.record('g', { ...opts, turnId: 'first', receipt: { message_id: 'one' } });
    const claim = manager.claim('g', 'one', 'incoming');
    time = 91000;
    assert.equal(manager.find('g', 'one'), null);
    manager.record('g', { ...opts, turnId: 'other', receipt: { message_id: 'two' } });
    assert.equal(manager.windows.get(window.key), window);
    claim.release(); claim.release();
    assert.equal(window.pending, 0);
    assert.equal(manager.windows.has(window.key), false);
});

test('每条回执保存各自图片，文本回执不继承较早图片', () => {
    const manager = new QuotedContinuation(), token = { key: 'g', epoch: 0 };
    const opts = { token, history: [], text: '正文' };
    const window = manager.record('g', { ...opts, turnId: 'first', receipt: { message_id: 'cat' }, images: [{ src: 'https://example.com/cat', speakerId: 'A' }] });
    manager.record('g', { ...opts, window, receipt: { message_id: 'dog' }, images: [{ src: 'https://example.com/dog', speakerId: 'B' }] });
    manager.record('g', { ...opts, window, receipt: { message_id: 'text' }, images: [] });
    const cat = manager.claim('g', 'cat'), dog = manager.claim('g', 'dog'), text = manager.claim('g', 'text');
    assert.equal(cat.images[0].src, 'https://example.com/cat');
    assert.equal(dog.images[0].src, 'https://example.com/dog');
    assert.deepEqual(text.images, []);
    assert.deepEqual(window.images, []);
    cat.images[0].src = 'changed';
    assert.equal(window.receipts.get('cat').images[0].src, 'https://example.com/cat');
    for (const claim of [cat, dog, text]) claim.release();
});

test('图片来源缓存按窗口和全局限额降级，仍保留归属及不可用说明', () => {
    const manager = new QuotedContinuation(), token = { key: 'g', epoch: 0 };
    const opts = { token, history: [], text: '正文' }, source = 'data:image/png;base64,' + 'A'.repeat(11 * 1024 * 1024);
    const first = manager.record('g', { ...opts, turnId: '1', receipt: { message_id: '1' }, images: [{ src: source, speakerId: 'A' }] });
    manager.record('g', { ...opts, window: first, receipt: { message_id: 'extra' }, images: [{ src: 'B'.repeat(2 * 1024 * 1024), speakerId: 'B', label: '乙的图片' }] });
    assert.equal(first.images[0].src, undefined);
    assert.equal(first.images[0].speakerId, 'B');
    assert.match(first.images[0].unavailableReason, /容量/);
    manager.record('g', { ...opts, turnId: '2', receipt: { message_id: '2' }, images: [{ src: source, speakerId: 'C' }] });
    const third = manager.record('g', { ...opts, turnId: '3', receipt: { message_id: '3' }, images: [{ src: source, speakerId: 'D' }] });
    assert.equal(third.images[0].src, undefined);
    assert.equal(third.images[0].unavailable, true);
});
