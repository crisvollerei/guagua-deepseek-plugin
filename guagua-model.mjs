// 所有模型任务共用的完成状态验收。只有完成的正文或当前允许的工具调用可继续处理。
export function completionMessage(result, { allowTools = false, label = '模型' } = {}) {
    const choice = result?.choices?.[0];
    const reason = choice?.finish_reason;
    const fail = (message, code) => { throw Object.assign(new Error(`${label}${message}`), { code, finishReason: reason }); };
    if (!choice || !choice.message || typeof choice.message !== 'object') fail('没有返回有效消息', 'MODEL_RESPONSE_INVALID');
    if (reason === 'length') fail('输出被长度限制截断，未采纳不完整结果', 'MODEL_OUTPUT_TRUNCATED');
    if (reason !== 'stop' && !(allowTools && reason === 'tool_calls')) {
        fail(`没有正常完成（${reason || '缺少完成状态'}），未采纳结果`, 'MODEL_OUTPUT_INTERRUPTED');
    }
    const message = choice.message;
    const calls = message.tool_calls;
    if (reason === 'tool_calls') {
        if (!Array.isArray(calls) || !calls.length) fail('工具调用结构不完整', 'MODEL_RESPONSE_INVALID');
        const ids = new Set();
        for (const call of calls) {
            if (!call || call.type !== 'function' || typeof call.id !== 'string' || !call.id.trim() || ids.has(call.id) ||
                typeof call.function?.name !== 'string' || !call.function.name.trim() || typeof call.function.arguments !== 'string') {
                fail('工具调用结构不完整或编号重复', 'MODEL_RESPONSE_INVALID');
            }
            ids.add(call.id);
        }
    } else {
        if (Array.isArray(calls) && calls.length) fail('正文完成状态与工具调用不一致', 'MODEL_RESPONSE_INVALID');
        if (typeof message.content !== 'string' || !message.content.trim()) fail('未返回可用正文', 'MODEL_EMPTY_CONTENT');
    }
    return message;
}
