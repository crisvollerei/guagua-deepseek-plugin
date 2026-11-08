import { randomUUID } from 'node:crypto';

export const REPLY_RULES = `
★ 最终回复的发送格式：
- 沿用当前人设、语气和对话氛围表达。分段只标记自然说话的停顿，不改变用词、情绪和表达习惯，不为分段压缩或补写内容。
- 有自然停顿时再分次发送；一句话说完就只发一条，不规定每轮的条数或结构，不按每个逗号或短句拆分。紧密相连的解释、代码块、链接、引用和表格保持完整。
- 回复可以自然结束。只在确实需要澄清或当前互动自然需要时追问，不为了延续对话、补一条消息而追加“有什么想聊的”“还有什么需要”等泛泛追问。
- 最终回复使用以下内部消息格式，不把格式说明当成聊天正文。
- 普通回复格式：{"reply_format":"guagua-v1","mode":"chat","messages":["第一条自然消息","确实需要时的下一条"]}。
- messages数组的一项就是一条实际QQ消息。需要分次说的几段话必须分别放进不同项，不要仅在同一项里用换行或空行冒充分次发送。
- 需要长篇教程、较长代码、复杂资料整理时，给出简短且具体的结论，再把完整正文放进转发格式：{"reply_format":"guagua-v1","mode":"forward","intro":"简短结论","sections":["一个完整要点或段落","另一个要点；代码块须完整"]}。简短列表无需转发。
- 用户明确要求别拆分、只发一条或直接发全文时，用mode="single"和messages数组的一条完整内容。用户需要JSON或代码时，把原样内容作为消息字符串，不把交付格式本身当作用户要的数据。
- 引用续聊时直接承接本次追问，按需要简短回应或补充说明。多人接话时，以每条消息标明的userid区分发言人；引用机器人回答只表示参与话题，不代表引用者认领之前成员的宠物、偏好、经历或约定。
- 这个格式只适用于最终聊天回复，调用工具时继续使用正常tool_calls，不要把工具调用或控制字段写进聊天正文。`;

const size = text => Array.from(text).length;
const trimLines = value => value.replace(/^\n+|\n+$/g, '');
const strings = value => Array.isArray(value) ? value.filter(v => typeof v === 'string' && v.trim()).map(trimLines) : [];
export const replySendFailed = value => value === false || value === null || Boolean(value?.error) || value?.status === 'failed';

// 这是旧版历史的保留路由格式。只清除此格式，不按userid或所有【标题】泛删正文。
const routingTitle = [...'机器人回应的发言人'].join('\\s*');
const routingUser = 'u\\s*s\\s*e\\s*r\\s*_?\\s*i\\s*d';
const internalReplyMarker = new RegExp(`【\\s*${routingTitle}\\s*(?:[:：]\\s*(?:${routingUser}\\s*[:=：]\\s*[0-9]+(?:\\s+[0-9]+)*\\s*)?)?】`, 'giu');

function stripInternalParts(parts) {
    const values = parts.map(value => typeof value === 'string' ? value : '');
    const joined = values.join('\n'), ranges = [];
    for (const match of joined.matchAll(internalReplyMarker)) {
        let start = match.index, end = start + match[0].length;
        const lineStart = joined.lastIndexOf('\n', start - 1) + 1;
        const nextLine = joined.indexOf('\n', end), lineEnd = nextLine < 0 ? joined.length : nextLine;
        // 单独一行的内部标记连同该行移除，避免凭空制造聊天停顿。
        const standalone = !joined.slice(lineStart, start).trim() && !joined.slice(end, lineEnd).trim();
        const routed = /user_?id[:=：][0-9]/i.test(match[0].replace(/\s/g, ''));
        if (!routed && !standalone) continue;
        if (standalone) {
            start = lineStart; end = nextLine < 0 ? lineEnd : lineEnd + 1;
        }
        ranges.push([start, end]);
    }
    // 仅当围栏内部因清理这些标记而变空时移除围栏；用户本来就发的空代码块保留。
    const remaining = (start, end) => {
        let cursor = start, value = '';
        for (const [from, to] of ranges) {
            if (to <= start || from >= end) continue;
            value += joined.slice(cursor, Math.max(cursor, from)); cursor = Math.min(end, Math.max(cursor, to));
        }
        return value + joined.slice(cursor, end);
    };
    let fence = null, lineOffset = 0;
    for (const line of joined.split('\n')) {
        const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
        if (match && !fence) fence = { char: match[1][0], length: match[1].length, start: lineOffset, body: lineOffset + line.length + 1 };
        else if (match && fence && match[1][0] === fence.char && match[1].length >= fence.length && !match[2].trim()) {
            if (ranges.some(([start, end]) => start < lineOffset && end > fence.body) && !remaining(fence.body, lineOffset).trim()) {
                ranges.push([fence.start, Math.min(joined.length, lineOffset + line.length + 1)]);
            }
            fence = null;
        }
        lineOffset += line.length + 1;
    }
    ranges.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const range of ranges) {
        const previous = merged.at(-1);
        if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]);
        else merged.push([...range]);
    }
    let offset = 0;
    return values.map(value => {
        let cursor = 0, result = '';
        for (const [start, end] of merged) {
            if (end <= offset || start >= offset + value.length) continue;
            const from = Math.max(cursor, start - offset), to = Math.min(value.length, end - offset);
            result += value.slice(cursor, from); cursor = Math.max(cursor, to);
        }
        result += value.slice(cursor);
        offset += value.length + 1;
        return result;
    });
}

export function stripInternalReplyMetadata(value) { return stripInternalParts([String(value ?? '')])[0]; }

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

function jsonContainer(text) {
    if (!/^[\[{]/.test(text.trim())) return false;
    try { const value = JSON.parse(text); return value !== null && typeof value === 'object'; } catch { return false; }
}

function blockKind(text) {
    if (jsonContainer(text) || /^ {0,3}(?:`{3,}|~{3,})|^(?: {4}|\t)/m.test(text)) return 'code';
    if (/^ {0,3}(?:[-+*]\s+|\d+[.)]\s+|\d+、\s*)/.test(text)) return 'list';
    if (/^ {0,3}>/.test(text)) return 'quote';
    if (/^\s*\|.*\|\s*$/m.test(text)) return 'table';
    return 'prose';
}

function plainLineParts(block) {
    // 换行位于代码、列表或其他排版结构中时，不把每一行当作聊天停顿。
    if (blockKind(block) !== 'prose' || /^ {0,3}(?:#{1,6}\s|[-+*]\s+|\d+[.)]\s+|\d+、\s*|>)/m.test(block)) return [block];
    const parts = [];
    for (const line of block.split('\n')) {
        const previous = parts.at(-1);
        const boundary = previous && (/[。！？!?；;…～~][”’」』）)]*$/.test(previous.trim()) ||
            /^(?:好[呀啊哇的]?|嗯+|哈+|哎呀|原来如此|等一下|是的)[。！？!~～…]*$/.test(previous.trim()));
        if (!previous || boundary) parts.push(line);
        else parts[parts.length - 1] += `\n${line}`;
    }
    return parts;
}

function conversationParts(text) {
    if (jsonContainer(text) || /^ {0,3}\[[^\]\n]+\]:\s*\S+/m.test(text)) return [text];
    const blocks = markdownSections(text.replace(/\r\n?/g, '\n')).flatMap(plainLineParts);
    if (blocks.length <= 1) return [text];
    const parts = [];
    for (const block of blocks) {
        const kind = blockKind(block), previous = parts.at(-1);
        const introduction = previous && (/[:：]$/.test(previous.text.trim()) ||
            /^(?: {0,3}#{1,6}\s[^\n]+|\*\*[^*\n]+\*\*[:：]?)$/.test(previous.text.trim()));
        const sameStructure = previous && kind !== 'prose' && previous.kind === kind;
        if (introduction || sameStructure) {
            previous.text += `\n\n${block}`;
            previous.kind = kind;
        } else parts.push({ text: block, kind });
    }
    return parts.map(part => part.text);
}

function consolidate(parts, target, separator = '\n') {
    if (parts.length <= target) return parts;
    const groups = [], goal = Math.ceil(parts.reduce((n, p) => n + size(p), 0) / target);
    let group = [];
    for (const part of parts) {
        // 较长的一项出现在末尾时，先结束已有小组，避免把前面的全部消息吞进一条。
        if (group.length && size([...group, part].join(separator)) > goal && groups.length < target - 1) {
            groups.push(group.join(separator)); group = [];
        }
        group.push(part);
        if (size(group.join(separator)) >= goal && groups.length < target - 1) { groups.push(group.join(separator)); group = []; }
    }
    if (group.length) groups.push(group.join(separator));
    return groups;
}

export function planReply(raw, { single = false, cleanText = text => text } = {}) {
    const input = typeof raw === 'string' ? stripInternalReplyMetadata(raw) : raw;
    const object = readObject(input);
    const structured = object?.reply_format === 'guagua-v1';
    if (raw && typeof raw === 'object' && !structured) throw Error('回复消息格式无效');
    const mode = structured ? object.mode : 'chat';
    if (structured && !['chat', 'single', 'forward'].includes(mode)) throw Error('回复发送方式无效');
    if (structured) {
        const content = mode === 'forward' ? object.sections : object.messages;
        if (!Array.isArray(content) || content.some(part => typeof part !== 'string')) throw Error('回复消息格式无效：正文必须是字符串数组');
    }
    let parts = structured ? strings(mode === 'forward' ? object.sections : object.messages) : [String(input ?? '')];
    const rawIntro = structured && typeof object.intro === 'string' ? object.intro : '';
    // 在公开发送与历史分叉前清理；整组匹配也能覆盖被模型拆到多个数组项的同一标记。
    const cleaned = stripInternalParts(stripInternalParts([rawIntro, ...parts]).map(part => part.trim() ? cleanText(part) : part));
    let intro = cleaned[0].trim();
    parts = protectParts(cleaned.slice(1).filter(part => part.trim()).map(trimLines));
    if (!parts.length) return { mode: 'chat', messages: intro ? [intro] : [], intro: '', sections: [] };
    if (single || mode === 'single') return { mode: 'single', messages: [([intro, ...parts].filter(Boolean)).join('\n\n')], intro: '', sections: [] };
    const body = parts.join('\n\n'), length = size(body), blocks = markdownSections(body);
    const substantial = length >= 900 || (blocks.length >= 5 && length >= 550) || (/^ {0,3}(?:`{3,}|~{3,})/m.test(body) && length >= 450);
    if (substantial || (mode === 'forward' && length >= 450)) {
        return { mode: 'forward', messages: [], intro, sections: consolidate(blocks, 10, '\n\n') };
    }
    // 兼容模型直接输出多段正文，或把多个自然段塞进messages的同一项。
    parts = protectParts(parts.flatMap(conversationParts));
    if (intro) parts.unshift(intro);
    if (parts.length > 4) parts = consolidate(parts, 3);
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
            let sent = false, seen, receipt;
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
                    receipt = await send(payload, !state.quoteUsed);
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
            await onProgress(state, receipt);
        }
        return true;
    }
}

// 只保存实际发出的正文及其回执编号，不读取群消息或访问网络。
export class QuotedContinuation {
    constructor({ now = Date.now, ttl = 90000, limit = 500 } = {}) {
        this.now = now;
        this.ttl = ttl;
        this.limit = limit;
        this.windows = new Map();
    }

    prune() {
        for (const [key, window] of this.windows) {
            if (window.expiresAt <= this.now() && !window.pending) this.windows.delete(key);
        }
        while (this.windows.size > this.limit) {
            const removable = [...this.windows.values()].find(window => !window.pending);
            if (!removable) break;
            this.windows.delete(removable.key);
        }
    }

    get(key) {
        this.prune();
        const window = this.windows.get(key);
        return window?.expiresAt > this.now() ? window : null;
    }

    record(scope, { turnId, token, receipt, text, history, window, images = [], userId = '', userName = '' }) {
        const ids = this.receiptIds(receipt);
        if (!ids.length) return null;
        const key = window?.key || `${scope}:thread:${turnId}`;
        if (window && (window.scope !== scope || this.windows.get(key) !== window)) return null;
        if (!window) {
            const previous = this.windows.get(key);
            window = previous?.turnId === turnId ? previous : {
                key, scope, turnId, receipts: new Map(), seen: new Set(), pending: 0
            };
        }
        window.retain ||= () => this.retain(window);
        window.token = { key: token.key, epoch: token.epoch };
        window.history = history.map(message => ({ role: message.role, content: String(message.content).slice(0, 3500),
            ...(message.replyToUserId != null && String(message.replyToUserId) ? { replyToUserId: String(message.replyToUserId) } : {}) }));
        window.expiresAt = this.now() + this.ttl;
        const incoming = ids.slice(-32), projected = new Map(window.receipts);
        for (const id of incoming) {
            projected.delete(id);
            projected.set(id, null);
        }
        while (projected.size > 32) projected.delete(projected.keys().next().value);
        const retained = [...projected.values()].filter(Boolean);
        const metadata = this.imageMetadata(images, window, retained);
        window.images = metadata.images;
        window.imageOmitted = metadata.omitted;
        for (const id of incoming) projected.set(id, { text, replyToUserId: String(userId), replyToName: String(userName),
            images: metadata.images, imageOmitted: metadata.omitted });
        window.receipts = projected;
        this.windows.delete(key);
        this.windows.set(key, window);
        this.prune();
        return window;
    }

    imageSources(receipts) {
        return new Set([...receipts].flatMap(receipt => (receipt?.images || []).map(image => image.src).filter(src => typeof src === 'string' && src)));
    }

    retain(window) {
        if (this.windows.get(window.key) !== window) return () => {};
        window.pending++;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            window.pending--;
            this.prune();
        };
    }

    imageMetadata(images, window, retained) {
        const supplied = Array.isArray(images) ? images : [];
        const ownSources = this.imageSources(retained);
        const bytes = sources => [...sources].reduce((sum, src) => sum + Buffer.byteLength(src, 'utf8'), 0);
        let ownBytes = bytes(ownSources), totalBytes = ownBytes;
        for (const other of this.windows.values()) if (other !== window) totalBytes += bytes(this.imageSources(other.receipts.values()));
        const result = supplied.slice(0, 8).map(image => {
            const item = {};
            for (const key of ['speakerId', 'speakerName', 'messageId', 'origin', 'label', 'unavailableReason']) {
                if (typeof image?.[key] === 'string') item[key] = image[key].slice(0, 500);
            }
            const src = typeof image?.src === 'string' ? image.src : '';
            if (src) {
                const added = ownSources.has(src) ? 0 : Buffer.byteLength(src, 'utf8');
                if (ownBytes + added <= 12 * 1024 * 1024 && totalBytes + added <= 32 * 1024 * 1024) {
                    item.src = src;
                    ownSources.add(src);
                    ownBytes += added;
                    totalBytes += added;
                } else item.unavailableReason = '图片来源缓存容量限制';
            }
            if (!item.src) {
                item.unavailable = true;
                item.unavailableReason ||= '未保留可读取的图片来源';
            }
            return item;
        });
        return { images: result, omitted: Math.max(0, supplied.length - result.length) };
    }

    receiptIds(receipt) {
        if (!receipt || typeof receipt !== 'object' || replySendFailed(receipt)) return [];
        if (Array.isArray(receipt)) return receipt.flatMap(item => this.receiptIds(item));
        const values = [receipt.message_id, receipt.messageId, receipt.id].flat();
        if (receipt.data && receipt.data !== receipt) values.push(...this.receiptIds(receipt.data));
        return [...new Set(values.filter(value => typeof value === 'string' || typeof value === 'number')
            .map(String).filter(value => value && value !== '0'))];
    }

    find(scope, replyId) {
        this.prune();
        return [...this.windows.values()].reverse().find(window => window.scope === scope &&
            window.expiresAt > this.now() && window.receipts.has(String(replyId))) || null;
    }

    claim(scope, replyId, messageId = '') {
        const window = this.find(scope, replyId);
        if (!window) return null;
        const duplicate = messageId ? window.seen.has(String(messageId)) : false;
        if (messageId) window.seen.add(String(messageId));
        while (window.seen.size > 64) window.seen.delete(window.seen.values().next().value);
        const reference = window.receipts.get(String(replyId));
        const release = duplicate ? () => {} : this.retain(window);
        return { key: window.key, window, quotedText: reference.text,
            replyToUserId: reference.replyToUserId, replyToName: reference.replyToName, duplicate,
            images: (reference.images || []).map(image => ({ ...image })), imageOmitted: reference.imageOmitted || 0,
            release };
    }
}
