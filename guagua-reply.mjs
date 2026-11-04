import { randomUUID } from 'node:crypto';

export const REPLY_RULES = `
★ 聊天回复与发送方式：
- 最终回复使用内部消息格式，不把格式说明当成聊天正文。正常聊天按真实说话时的停顿组织，通常1～3条；一句话能说完就只发一条，不要凑条数，也不要每个逗号或短句都拆开发。
- 每条表达一个相对完整的意思。短反应后可以另发补充或问题；紧密相连的解释放在一起。不要为了显得简短而省略必要内容，代码块、链接、引用和表格不能拆断。
- 普通回复格式：{"reply_format":"guagua-v1","mode":"chat","messages":["第一条自然消息","确实需要时的下一条"]}。
- 需要长篇教程、较长代码、复杂资料整理时，给出简短且具体的结论，再把完整正文放进转发格式：{"reply_format":"guagua-v1","mode":"forward","intro":"简短结论","sections":["一个完整要点或段落","另一个要点；代码块须完整"]}。简短列表无需转发。
- 用户明确要求别拆分、只发一条或直接发全文时，用mode="single"和messages数组的一条完整内容。用户需要JSON或代码时，把原样内容作为消息字符串，不把交付格式本身当作用户要的数据。
- 陪伴模式通常只接一句，必要时再补一句；陪伴判断的should_reply/reason/need_query保持外层JSON，reply字段填写上述消息对象，无需回复时reply为空字符串。
- 这个格式只适用于最终聊天回复，调用工具时继续使用正常tool_calls，不要把工具调用或控制字段写进聊天正文。`;

const size = text => Array.from(text).length;
const trimLines = value => value.replace(/^\n+|\n+$/g, '');
const strings = value => Array.isArray(value) ? value.filter(v => typeof v === 'string' && v.trim()).map(trimLines) : [];
export const replySendFailed = value => value === false || value === null || Boolean(value?.error) || value?.status === 'failed';

export function prefersSingleReply(question = '') {
    return /(?:^|[，,。；;\n])\s*(?:(?:这次|本次|请|麻烦你?|回复时|回答时)\s*)*(?:不要拆(?:分)?|别拆(?:分)?|不要分条|别分条|只发一条|发一条消息|用一条消息|一次发完|直接发全文)(?:回复|回答|发送)?(?=$|[，,。！!；;\s])/.test(question);
}

function readObject(raw) {
    if (raw && typeof raw === 'object') return raw;
    const text = String(raw ?? '').trim();
    const fenced = text.match(/^```(?:json)?[ \t]*\n?([\s\S]*?)\n?```$/i);
    try { return JSON.parse(fenced ? fenced[1] : text); } catch {
        if (/^\s*\{[\s\S]*"reply_format"\s*:\s*"guagua-v1"/.test(fenced ? fenced[1] : text)) throw Error('回复消息格式不完整');
        return null;
    }
}

function openFence(text) {
    let fence = null;
    for (const line of text.split('\n')) {
        const m = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
        if (!m) continue;
        if (!fence) fence = { char: m[1][0], length: m[1].length };
        else if (m[1][0] === fence.char && m[1].length >= fence.length && !m[2].trim()) fence = null;
    }
    return fence;
}

function protectParts(parts) {
    const output = [];
    for (const part of parts) {
        const last = output.at(-1);
        if (last && (openFence(last) || (/\|[^\n]+\|\s*$/.test(last) && /^\s*\|/.test(part)))) output[output.length - 1] += `\n${part}`;
        else if (last && (/\[[^\]\n]*$|\][(][^)]*$/.test(last) || (/https?:\/\/\S+$/.test(last) && /^[/?&#]/.test(part)))) output[output.length - 1] += part;
        else output.push(part);
    }
    return output;
}

export function markdownSections(text) {
    const sections = [];
    let lines = [], fence = null;
    for (const line of text.split('\n')) {
        const m = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
        if (m) {
            if (!fence) fence = { char: m[1][0], length: m[1].length };
            else if (m[1][0] === fence.char && m[1].length >= fence.length && !m[2].trim()) fence = null;
        }
        if (!line.trim() && !fence) {
            if (lines.length) { sections.push(lines.join('\n')); lines = []; }
        } else lines.push(line);
    }
    if (lines.length) sections.push(lines.join('\n'));
    return sections.filter(Boolean);
}

function consolidate(parts, target, separator = '\n') {
    if (parts.length <= target) return parts;
    const groups = [], goal = Math.ceil(parts.reduce((n, p) => n + size(p), 0) / target);
    let group = [];
    for (const part of parts) {
        group.push(part);
        if (size(group.join(separator)) >= goal && groups.length < target - 1) { groups.push(group.join(separator)); group = []; }
    }
    if (group.length) groups.push(group.join(separator));
    return groups;
}

export function planReply(raw, { single = false, companion = false, cleanText = text => text } = {}) {
    const object = readObject(raw);
    const structured = object?.reply_format === 'guagua-v1';
    if (raw && typeof raw === 'object' && !structured) throw Error('回复消息格式无效');
    const mode = structured ? object.mode : 'chat';
    if (structured && !['chat', 'single', 'forward'].includes(mode)) throw Error('回复发送方式无效');
    const transform = parts => parts.map(cleanText).filter(p => typeof p === 'string' && p.trim()).map(trimLines);
    let intro = structured && typeof object.intro === 'string' ? cleanText(object.intro).trim() : '';
    let parts = structured ? strings(mode === 'forward' ? object.sections : object.messages) : [String(raw ?? '')];
    parts = protectParts(transform(parts));
    if (!parts.length) return { mode: 'chat', messages: [], intro: '', sections: [] };
    if (single || mode === 'single') return { mode: 'single', messages: [([intro, ...parts].filter(Boolean)).join('\n\n')], intro: '', sections: [] };
    const body = parts.join('\n\n'), length = size(body), blocks = markdownSections(body);
    const substantial = length >= 900 || (blocks.length >= 5 && length >= 550) || (/^ {0,3}(?:`{3,}|~{3,})/m.test(body) && length >= 450);
    if (substantial || (mode === 'forward' && length >= 450)) {
        return { mode: 'forward', messages: [], intro, sections: consolidate(blocks, 10, '\n\n') };
    }
    if (intro) parts.unshift(intro);
    if (parts.length > (companion ? 3 : 4)) parts = consolidate(parts, companion ? 2 : 3);
    return { mode: 'chat', messages: parts, intro: '', sections: [] };
}

export class ReplyDelivery {
    constructor({ sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), random = Math.random } = {}) {
        this.sleep = sleep;
        this.random = random;
        this.payloads = new WeakMap();
    }

    create(plan) {
        return { id: `reply-${randomUUID()}`, next: 0, history: [], mentioned: [], quoteUsed: false,
            items: plan.mode === 'forward' ? [{ kind: 'forward', sections: plan.sections, intro: plan.intro }] : plan.messages.map(text => ({ kind: 'text', text })) };
    }

    async pause(valid, duration = 600 + Math.floor(this.random() * 901)) {
        for (let left = duration; left > 0; left -= 150) {
            if (!valid()) return false;
            await this.sleep(Math.min(150, left));
        }
        return valid();
    }

    async send(state, { valid = () => true, send, render = text => text, makeForward, onProgress = () => {}, attempts = 1 } = {}) {
        while (state.next < state.items.length) {
            if (!valid()) return false;
            let item = state.items[state.next];
            if (item.kind === 'forward' && !this.payloads.has(item)) {
                let payload;
                const mentioned = new Set(state.mentioned);
                try {
                    // 转发先构造后发引言；预先计入引言的@，避免卡片再次提醒同一人。
                    if (item.intro) await render(item.intro, mentioned);
                    const nodes = [];
                    for (const text of item.sections) nodes.push(await render(text, mentioned));
                    payload = await makeForward?.(nodes);
                } catch { /* 不支持合并转发时按完整段落回退。 */ }
                if (!valid()) return false;
                const supported = payload && typeof payload === 'object' && !replySendFailed(payload) && (!Array.isArray(payload) || payload.some(p => p && typeof p === 'object'));
                if (supported) {
                    this.payloads.set(item, { payload, mentioned: [...mentioned] });
                    state.items.splice(state.next, 0, { kind: 'text', text: item.intro || '详细内容我整理在下面了。' });
                } else {
                    const texts = consolidate(item.sections, 3, '\n\n');
                    state.items.splice(state.next, 1, ...[item.intro, ...texts].filter(Boolean).map(text => ({ kind: 'text', text })));
                }
                continue;
            }
            if (state.quoteUsed && !await this.pause(valid)) return false;
            let sent = false, seen;
            for (let attempt = 0; attempt < attempts; attempt++) {
                if (!valid()) return false;
                seen = new Set(state.mentioned);
                try {
                    let payload;
                    if (item.kind === 'forward') {
                        const cached = this.payloads.get(item);
                        payload = cached.payload;
                        for (const uid of cached.mentioned) seen.add(uid);
                    } else payload = await render(item.text, seen);
                    if (!valid()) return false;
                    const receipt = await send(payload, !state.quoteUsed);
                    if (replySendFailed(receipt)) throw Error('发送未成功');
                    sent = true;
                    break;
                } catch (error) {
                    if (!valid()) return false;
                    if (attempt + 1 >= attempts) throw Error('回复发送未成功', { cause: error });
                    if (!await this.pause(valid, 600)) return false;
                }
            }
            if (!sent) throw Error('回复发送未成功');
            state.next++;
            state.quoteUsed = true;
            state.mentioned = [...seen];
            state.history.push(item.kind === 'forward' ? item.sections.join('\n\n') : item.text);
            // 回执成功即提交进度，即使随后被打断也不能把已发出的部分重发。
            await onProgress(state);
        }
        return true;
    }
}
