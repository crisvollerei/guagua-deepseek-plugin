import test from 'node:test';
import assert from 'node:assert/strict';
import { planReply, ReplyDelivery, QuotedContinuation, stripInternalReplyMetadata } from '../guagua-reply.mjs';

const marker = '【机器人回应的发言人：userid=22222】';
const envelope = (messages, mode = 'chat') => ({ reply_format: 'guagua-v1', mode, messages });
const delivery = () => new ReplyDelivery({ sleep: async () => {}, random: () => 0 });
const visibleText = plan => [plan.intro, ...plan.messages, ...plan.sections].filter(Boolean).join('\n');

test('旧内部路由前缀的单行、冒号和跨行变体只清除标记，正文语气保持原样', () => {
    for (const metadata of [marker, '【机器人回应的发言人: userid:22222】',
        '【机器人回应的发言人：\nuserid：22222\n】',
        '【机器人回应的\n发言人：user_id = 22222】']) {
        assert.deepEqual(planReply(metadata + '\n哎呀，被你发现啦～').messages, ['哎呀，被你发现啦～']);
        assert.deepEqual(planReply('先说。' + metadata + '然后呢？').messages, ['先说。然后呢？']);
    }
    assert.equal(stripInternalReplyMetadata('第一行\n' + marker + '\n下一行'), '第一行\n下一行');
});

test('分段聊天在公开发送和历史入库前共同清理，不留下空消息或补造追问', async () => {
    const plan = planReply(envelope([marker, marker + '\n笨瓜在这儿呢～', '这回可没躲着你。' + marker]));
    assert.deepEqual(plan.messages, ['笨瓜在这儿呢～', '这回可没躲着你。']);
    const sender = delivery(), state = sender.create(plan), sent = [];
    await sender.send(state, { send: async text => { sent.push(text); return { message_id: String(sent.length) }; } });
    assert.deepEqual(sent, ['笨瓜在这儿呢～', '这回可没躲着你。']);
    assert.deepEqual(state.history, sent);
});

test('同一内部标记被拆到多个messages项时只移除标记，保留正文的原分段边界', () => {
    const plan = planReply(envelope(['第一句。', '【机器人回应的', '发言人：user', 'id=22222】第二句。', '第三句。']));
    assert.deepEqual(plan.messages, ['第一句。', '第二句。', '第三句。']);
    assert.equal(visibleText(plan).includes('22222'), false);
});

test('普通userid、QQ号说明、非保留标题、代码和JSON不被泛删', () => {
    for (const text of [
        'userid=22222是发言人的QQ号，你可以按它查资料。',
        '我的QQ号是22222，userid：22222。',
        '机器人回应的发言人：userid=22222，这里是在解释字段。',
        '【发言人：userid=22222】这是真实聊天内容。',
        '【机器人回应的发言人：春姐姐】只是普通人物说明。',
        '你看到的【机器人回应的发言人】只是内部字段标题。',
        '“【机器人回应的发言人】”这个标题是什么意思？',
        '【注意】这里使用user_id，别和message_id混淆。',
        '```js\nconst userid = 22222;\n    console.log(userid);\n```',
        '{"userid":22222,"description":"这是用户要求的JSON"}'
    ]) assert.deepEqual(planReply(text).messages, [text], text);
});

test('纯标题只在单独成行或成项时清理，正文中的同名标题保留', () => {
    assert.deepEqual(planReply('【机器人回应的发言人】\n正常正文。').messages, ['正常正文。']);
    assert.deepEqual(planReply(envelope(['【机器人回应的发言人】', '正常正文。'])).messages, ['正常正文。']);
    assert.deepEqual(planReply('解释【机器人回应的发言人】的含义。').messages, ['解释【机器人回应的发言人】的含义。']);
});

test('因移除内部标记而空的代码围栏清除，用户原本要求的空代码示例保留', () => {
    for (const fence of ['```text', '~~~json']) {
        const close = fence.startsWith('`') ? '```' : '~~~';
        assert.deepEqual(planReply(`${fence}\n${marker}\n${close}`).messages, []);
        assert.deepEqual(planReply(envelope([fence, marker, close, '正常正文。'])).messages, ['正常正文。']);
        const empty = `${fence}\n${close}`;
        assert.deepEqual(planReply(empty).messages, [empty]);
        assert.deepEqual(planReply(marker + '\n' + empty).messages, [empty], '标记在围栏外时不删用户已有空代码');
    }
});

test('内部前缀位于结构化回复外面时仍正确解析交付格式，不公开JSON信封', () => {
    assert.deepEqual(planReply(marker + '\n' + JSON.stringify(envelope(['正文一。', '正文二。']))).messages, ['正文一。', '正文二。']);
});

test('单条模式保留完整正文与代码缩进，路由标记不会进入正文', () => {
    const body = '说明如下：\n\n```js\n    const userid = 22222;\n```';
    const plan = planReply(envelope([marker, body], 'single'));
    assert.equal(plan.mode, 'single');
    assert.deepEqual(plan.messages, [body]);
});

test('转发引言和节点均在构造前清理，成功发送历史也没有内部标记', async () => {
    const first = '完整说明。'.repeat(100), second = '保留最后的语气～';
    const plan = planReply({ reply_format: 'guagua-v1', mode: 'forward', intro: marker + '\n先说结论。',
        sections: [marker + '\n' + first, second + marker] });
    assert.equal(plan.mode, 'forward');
    assert.equal(plan.intro, '先说结论。');
    assert.deepEqual(plan.sections, [first, second]);
    const sender = delivery(), state = sender.create(plan), sent = [];
    await sender.send(state, { makeForward: async nodes => ({ type: 'forward', nodes }),
        send: async payload => { sent.push(payload); return { message_id: String(sent.length) }; } });
    assert.equal(sent[0], '先说结论。');
    assert.deepEqual(sent[1].nodes, [first, second]);
    assert.deepEqual(state.history, ['先说结论。', first + '\n\n' + second]);
    assert.equal(JSON.stringify(sent).includes('机器人回应的发言人'), false);
});

test('转发回退普通消息时也只发送清理后的正文', async () => {
    const body = '完整说明。'.repeat(100), sender = delivery();
    const state = sender.create(planReply({ reply_format: 'guagua-v1', mode: 'forward', intro: marker,
        sections: ['【机器人回应的发言人：', 'userid=22222】' + body] }));
    const sent = [];
    await sender.send(state, { makeForward: async () => { throw Error('unsupported'); },
        send: async text => { sent.push(text); return true; } });
    assert.deepEqual(sent, [body]);
    assert.deepEqual(state.history, [body]);
});

test('只有内部标记或保留标题时不生成空消息、转发卡片、回执或历史', async () => {
    for (const raw of [marker, '【机器人回应的发言人】', '【机器人回应的发言人：】',
        envelope([marker]), envelope([marker], 'single'),
        { reply_format: 'guagua-v1', mode: 'forward', intro: marker, sections: [marker] }]) {
        const plan = planReply(raw), sender = delivery(), state = sender.create(plan);
        assert.deepEqual(plan.messages, []); assert.deepEqual(plan.sections, []);
        let sends = 0, forwards = 0, progress = 0;
        await sender.send(state, { send: async () => { sends++; }, makeForward: async () => { forwards++; }, onProgress: () => { progress++; } });
        assert.equal(sends, 0); assert.equal(forwards, 0); assert.equal(progress, 0);
        assert.deepEqual(state.history, []);
    }
});

test('正文全为内部标记但引言正常时只发真实引言，不造默认转发说明', () => {
    const plan = planReply({ reply_format: 'guagua-v1', mode: 'forward', intro: '这一句就够啦～', sections: [marker] });
    assert.equal(plan.mode, 'chat');
    assert.deepEqual(plan.messages, ['这一句就够啦～']);
    assert.deepEqual(plan.sections, []);
});

test('外部cleanText返回旧内部标记时在共同出口再次移除', () => {
    const calls = [];
    const plan = planReply(envelope([marker + '\n原正文。']), { cleanText: text => {
        calls.push(text); return marker + '\n' + text;
    } });
    assert.deepEqual(calls, ['原正文。']);
    assert.deepEqual(plan.messages, ['原正文。']);
});

test('引用窗口保留独立回应对象metadata，实际助手正文保持纯文本', () => {
    const manager = new QuotedContinuation(), scope = '12345:group:99999';
    const window = manager.record(scope, { turnId: 't1', token: { key: scope, epoch: 0 },
        receipt: { message_id: 'sent-1' }, text: '笨瓜在这儿呢～', userId: '44444',
        history: [{ role: 'user', content: '原问题' }, { role: 'assistant', content: '笨瓜在这儿呢～', replyToUserId: 44444 }] });
    assert.deepEqual(window.history, [{ role: 'user', content: '原问题' },
        { role: 'assistant', content: '笨瓜在这儿呢～', replyToUserId: '44444' }]);
    const claim = manager.claim(scope, 'sent-1', 'incoming');
    assert.equal(claim.window.history.at(-1).replyToUserId, '44444');
    assert.equal(claim.window.history.at(-1).content, '笨瓜在这儿呢～');
    claim.release();
});
