import test from 'node:test';
import assert from 'node:assert/strict';
import { pluginHarness, quotedHarness, message, turn, deferred } from './plugin-harness.mjs';
import { FakeClock } from './fake-clock.mjs';
import { tinyGif } from './vision-fixtures.mjs';
import { sessionKey } from '../guagua-memory.mjs';

const replyAll = params => {
    const input = JSON.parse(params.messages[1].content);
    return message({ action: 'reply', message_ids: input.messages.map(item => item.id), target_id: input.messages.at(-1).speaker_id });
};
const imageCount = content => Array.isArray(content) ? content.filter(item => item.type === 'image_url').length : 0;
async function drain(service) {
    for (let i = 0; i < 30; i++) {
        if (service.extracting) await turn();
        else if (service.store.data.observations.length) await service.processExtractions();
        else return;
    }
    assert.fail('记忆提取未在隔离模型响应后完成');
}

test('无引用编号的适配器仍能在普通限时追问中重用上一轮图片', async t => {
    const clock = new FakeClock(), gif = tinyGif([10]);
    const h = pluginHarness(t, { listeningClock: clock, judgment: replyAll,
        http: { get: async () => ({ data: gif, headers: { 'content-type': 'image/gif' } }) } });
    await h.instance.chat(h.event('#呱瓜 看这张', { message: [{ type: 'text', text: '#呱瓜 看这张' },
        { type: 'image', url: 'https://example.com/no-receipt-image' }] }));
    await h.instance.accept(h.event('它的右下角是什么？'));
    await clock.advance(8000);
    assert.equal(h.calls.length, 2);
    assert.equal(imageCount(h.calls[1].messages.at(-1).content), 1);
    assert.match(JSON.stringify(h.calls[1].messages.at(-1).content), /33333/);
});

test('引用原图后的新人自述仍只学习新人事实，不继承图片主人的宠物', async t => {
    const gif = tinyGif([10]), extracted = [];
    const h = quotedHarness(t, { http: { get: async () => ({ data: gif, headers: { 'content-type': 'image/gif' } }) },
        extraction: params => {
            const sources = JSON.parse(params.messages[1].content).messages;
            extracted.push(...sources);
            return message({ memories: sources.filter(source => source.text.includes('我的狗元宝怕水')).map(source => ({
                type: 'entity', userid: source.speakerId, scope: 'global', assertion: 'affirmed',
                content: '元宝怕水', entity: { name: '元宝', kind: '狗', relation: '宠物', attributes: '怕水' },
                claim: { field: 'trait', value: '怕水' }, evidence: '我的狗元宝怕水', source_id: source.id
            })) });
        } });
    await h.instance.chat(h.event('#呱瓜 看我的猫豆包', { message: [{ type: 'text', text: '#呱瓜 看我的猫豆包' },
        { type: 'image', url: 'https://example.com/owner-cat' }], sender: { nickname: '甲' } }));
    await h.receive(h.follow('我的狗元宝怕水，它们一样吗？', undefined, { user_id: 44444, sender: { nickname: '乙' } }));
    await drain(h.api.memory);
    const content = h.calls[1].messages.at(-1).content;
    assert.equal(imageCount(content), 1);
    assert.match(JSON.stringify(content), /33333/);
    assert.match(JSON.stringify(content), /44444/);
    const record = h.api.memory.store.data.records.find(item => item.entity?.name === '元宝');
    assert.equal(record.subjectId, '44444');
    assert.equal(record.source.speakerId, '44444');
    assert.doesNotMatch(record.content, /豆包/);
    assert.ok(extracted.filter(item => item.speakerId === '44444').every(item => !item.text.includes('看我的猫豆包')));
});

test('真实聊天提取后的跨群召回不携带同句其他人的临时事件', async t => {
    const h = pluginHarness(t, { extraction: params => {
        const source = JSON.parse(params.messages[1].content).messages.find(item => item.text.includes('我的猫豆包怕水'));
        return message({ memories: source ? [{ type: 'entity', userid: source.speakerId, scope: 'global', assertion: 'affirmed',
            content: '养了一只怕水的猫豆包', entity: { name: '豆包', kind: '猫', relation: '宠物', attributes: '怕水' },
            claim: { field: 'trait', value: '怕水' }, source_id: source.id, evidence: '我的猫豆包怕水' }] : [] });
    } });
    await h.instance.chat(h.event('#呱瓜 我的猫豆包怕水，阿红明天去医院'));
    await drain(h.api.memory);
    await h.instance.chat(h.event('#呱瓜 豆包怕什么', { group_id: 22222 }));
    assert.ok(h.api.memory.store.data.records.some(record => record.content.includes('豆包')));
    assert.doesNotMatch(h.calls.at(-1).messages[0].content, /阿红明天去医院/);
    assert.ok(h.api.memory.store.data.records.every(record => !record.content.includes('阿红明天去医院')));
});

test('长请求失败后旧引用过期，仍在有效期的普通接话成功时建立新引用窗口', async t => {
    const clock = new FakeClock(0), started = deferred(), failed = deferred();
    const h = quotedHarness(t, { listeningClock: clock, judgment: replyAll,
        response: (_params, count) => count === 2 ? (started.resolve(), failed.promise) : message(count === 1 ? '起始回答' : '恢复后的回答') });
    h.api.quoteContinuations.now = clock.now;
    await h.instance.chat(h.event('#呱瓜 开始'));
    const oldId = h.sent.at(-1).receipt.message_id;
    await clock.advance(59000);
    const follow = h.follow('第59秒的明确追问', oldId);
    await h.instance.accept(follow);
    await started.promise;
    const pending = h.api.memory.chains.get(sessionKey(follow));
    await clock.advance(36000);
    failed.reject(Error('临时模型错误'));
    await pending;
    assert.equal(h.api.quoteContinuations.find(sessionKey(follow), oldId), null);
    await h.instance.accept(h.event('继续刚才的问题'));
    await clock.advance(8000);
    assert.equal(h.calls.length, 3);
    assert.ok(h.api.quoteContinuations.find(sessionKey(follow), h.sent.at(-1).receipt.message_id));
});

test('另开话题不夺回旧焦点，已成功发出的迟到回执仍允许其他成员引用', async t => {
    const started = deferred(), receipt = deferred();
    const h = quotedHarness(t, { response: (_params, count) => message(count === 1 ? '实际发出的旧回答' : '新话题回答') });
    const old = h.event('#呱瓜 旧话题', { reply: async () => { started.resolve(); return receipt.promise; } });
    const pending = h.instance.chat(old);
    await started.promise;
    const next = h.event('#呱瓜 新话题');
    const newer = h.instance.chat(next);
    receipt.resolve(true);
    await Promise.all([pending, newer]);
    const state = h.api.conversationListening.byUser(sessionKey(next), next.user_id);
    assert.equal(state.root.eventId, next.message_id);
    assert.ok(h.api.quoteContinuations.find(sessionKey(old), h.sent[0].receipt.message_id));
    assert.doesNotMatch(JSON.stringify(state.history), /实际发出的旧回答/);
});
