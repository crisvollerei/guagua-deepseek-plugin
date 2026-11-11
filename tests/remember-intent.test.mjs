import test from 'node:test';
import assert from 'node:assert/strict';
import { quotedHarness, message } from './plugin-harness.mjs';

const fact = '我家的猫叫豆包';

function setup(t, pluginConfig = {}) {
    return quotedHarness(t, { pluginConfig, extraction: params => {
        const sources = JSON.parse(params.messages[1].content).messages.filter(source => source.text.includes(fact));
        return message({ memories: sources.map(source => ({ type: 'entity', userid: source.speakerId, scope: 'global',
            assertion: 'affirmed', entity: { name: '豆包', kind: '猫', relation: '宠物' }, content: fact,
            source_id: source.id, evidence: fact, claim: { field: 'ownership', value: '豆包' } })) });
    }, response: () => message('布偶猫的介绍') });
}

function quote(h, request) {
    const e = h.event(h.pluginConfig.command.chatPrefix + ' ' + request, { reply_id: 'original-fact', getReply: async () => ({
        user_id: 44444, group_id: 99999, message_id: 'original-fact', time: 1794110400,
        sender: { nickname: '原作者' }, message: [{ type: 'text', text: fact }]
    }) });
    e.bot.gml = new Map([[99999, new Map([[33333, { user_id: 33333 }], [44444, { user_id: 44444 }]])]]);
    return e;
}

test('自然语序、句尾记一下和无逗号的自述走真实回执，保留原话', async t => {
    for (const request of ['记住' + fact, '帮我记一下' + fact, fact + '，帮我记下来']) {
        const h = setup(t); await h.instance.chat(h.event('#呱瓜 ' + request));
        const entries = Object.values(h.api.memory.store.data.intakeLog);
        assert.equal(entries.length, 1);
        assert.equal(entries[0].requested, true, request);
        assert.equal(entries[0].text, request);
        assert.equal(h.calls.length, 0, request);
        assert.match(JSON.stringify(h.sent.at(-1).payload), /已收录 1 条/, request);
    }
});

test('引用时“记下来”和礼貌请求按原作者核实收录', async t => {
    for (const request of ['把这条记下来', '这条帮我记一下', '能帮我记住这条吗？']) {
        const h = setup(t); await h.instance.chat(quote(h, request));
        assert.equal(h.calls.length, 0, request);
        const record = h.api.memory.store.data.records.at(-1);
        assert.equal(record.subjectId, '44444');
        assert.equal(record.source.quote, fact);
        assert.match(JSON.stringify(h.sent.at(-1).payload), /已收录 1 条/);
    }
});

test('回忆问句、取消和普通叙述不请求重新提取引用', async t => {
    for (const request of ['记住这条了吗？', '记住这条没？', '你还记得吗？', '这条别帮我记下来', '他说，帮我记一下', '我记下来了']) {
        const h = setup(t); await h.instance.chat(quote(h, request));
        const entries = Object.values(h.api.memory.store.data.intakeLog);
        assert.ok(entries.every(entry => !entry.requested && entry.speakerId === '33333'), request);
        assert.equal(h.calls.length, 1);
    }
});

test('明确记住之外另有请求时带真实结果继续聊天，不吞第二个请求', async t => {
    const h = setup(t); await h.instance.chat(quote(h, '记住这条，顺便介绍一下布偶猫'));
    assert.equal(h.calls.length, 1);
    assert.match(h.calls[0].messages[0].content, /实际记忆收录结果：已收录 1 条/);
    assert.match(JSON.stringify(h.sent.at(-1).payload), /布偶猫的介绍/);
});

test('含正则符号的自定义前缀下，礼貌补记只发回执，复合请求继续回答', async t => {
    const chatPrefix = '#小[舟]';
    const h = setup(t, { command: { chatPrefix } });
    await h.dispatch(quote(h, '能帮我记住这条吗？'));
    assert.equal(h.calls.length, 0);
    assert.match(JSON.stringify(h.sent.at(-1).payload), /已收录 1 条/);
    await h.dispatch(h.event(chatPrefix + ' 记住' + fact + '，顺便介绍一下布偶猫'));
    assert.equal(h.calls.length, 1);
    assert.match(h.calls[0].messages[0].content, /实际记忆收录结果/);
    assert.match(JSON.stringify(h.sent.at(-1).payload), /布偶猫的介绍/);
});
