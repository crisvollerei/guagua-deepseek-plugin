import test from 'node:test';
import assert from 'node:assert/strict';
import { completionMessage } from '../guagua-model.mjs';

const result = (content, finish_reason = 'stop', extra = {}) => ({ choices: [{ finish_reason, message: { role: 'assistant', content, ...extra } }] });

test('完整正文保留原消息和思考字段，不改写人设表达', () => {
    const r = result('哎呀，我在呢～', 'stop', { reasoning_content: '内部思考' });
    assert.equal(completionMessage(r), r.choices[0].message);
});

test('工具调用仅在允许的阶段接受，保持原始工具结构', () => {
    const r = result(null, 'tool_calls', { tool_calls: [{ id: 't1', type: 'function', function: { name: 'web_search', arguments: '{bad JSON' } }] });
    assert.equal(completionMessage(r, { allowTools: true }), r.choices[0].message);
    assert.throws(() => completionMessage(r), { code: 'MODEL_OUTPUT_INTERRUPTED' });
    assert.throws(() => completionMessage(result('正文', 'stop', { tool_calls: r.choices[0].message.tool_calls })), { code: 'MODEL_RESPONSE_INVALID' });
});

test('被截断或中断的有效JSON也不能当成任务成功', () => {
    for (const reason of ['length', 'aborted', 'insufficient_system_resource', 'content_filter']) {
        assert.throws(() => completionMessage(result('{"memories":[]}', reason)), reason === 'length'
            ? { code: 'MODEL_OUTPUT_TRUNCATED' } : { code: 'MODEL_OUTPUT_INTERRUPTED' });
    }
});

test('工具缺少调用编号、函数结构损坏或编号重复时整轮拒绝', () => {
    const valid = { id: 't1', type: 'function', function: { name: 'web_search', arguments: '{}' } };
    for (const calls of [[{ ...valid, id: '' }], [{ ...valid, function: { name: 'web_search', arguments: {} } }],
        [{ ...valid, function: null }], [valid, valid]]) {
        assert.throws(() => completionMessage(result(null, 'tool_calls', { tool_calls: calls }), { allowTools: true }),
            { code: 'MODEL_RESPONSE_INVALID' });
    }
});

test('空正文、只返回思考、缺少完成状态或缺少消息均拒绝', () => {
    for (const r of [result(''), result('  '), result(null, 'stop', { reasoning_content: '仍在思考' })]) {
        assert.throws(() => completionMessage(r), { code: 'MODEL_EMPTY_CONTENT' });
    }
    assert.throws(() => completionMessage({ choices: [{ message: { content: '未声明完成' } }] }), { code: 'MODEL_OUTPUT_INTERRUPTED' });
    assert.throws(() => completionMessage({ choices: [] }), { code: 'MODEL_RESPONSE_INVALID' });
    assert.throws(() => completionMessage(result(null, 'tool_calls'), { allowTools: true }), { code: 'MODEL_RESPONSE_INVALID' });
});
