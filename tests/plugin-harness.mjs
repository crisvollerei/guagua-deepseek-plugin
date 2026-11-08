import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MemoryStore, MemoryService, MEMORY_RULES, sessionKey, normalizeId, parseJsonObject } from '../guagua-memory.mjs';
import { WebService, WEB_TOOLS, WEB_RULES } from '../guagua-web.mjs';
import { ReplyDelivery, QuotedContinuation, REPLY_RULES, planReply, prefersSingleReply, stripInternalReplyMetadata } from '../guagua-reply.mjs';
import { ConversationListening } from '../guagua-listen.mjs';
import { GifContactSheet } from '../guagua-vision.mjs';
import { FakeClock } from './fake-clock.mjs';
import { tinyGif, rgbaFrames } from './vision-fixtures.mjs';

import { completionMessage } from '../guagua-model.mjs';
import { config as repositoryConfig } from '../config.js';
export const profile = { version: 1, users: { '22222': { name: '主人', role: 'master', aliases: [], learned: [] } }, pending: [] };
export const message = (content, finish_reason = 'stop') => ({ choices: [{ finish_reason, message: { role: 'assistant', content: typeof content === 'string' ? content : JSON.stringify(content) } }] });
export const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
export const turn = () => new Promise(resolve => setImmediate(resolve));

function directory(t) {
    const base = fileURLToPath(new URL('./.tmp/', import.meta.url));
    fs.mkdirSync(base, { recursive: true });
    const root = fs.mkdtempSync(path.join(base, 'guagua-memory-test-'));
    t.after(() => {
        const absolute = path.resolve(root);
        assert.equal(path.dirname(absolute), path.resolve(base));
        assert.ok(path.basename(absolute).startsWith('guagua-memory-test-'));
        fs.rmSync(absolute, { recursive: true, force: true });
    });
    return root;
}

const mainSource = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');

function mergeConfig(base, overrides) {
    const result = structuredClone(base);
    for (const [key, value] of Object.entries(overrides || {})) {
        result[key] = value && typeof value === 'object' && !Array.isArray(value)
            ? mergeConfig(result[key] || {}, value) : structuredClone(value);
    }
    return result;
}

export function pluginHarness(t, { config = {}, pluginConfig = {}, response, extraction, p = profile, startup = [], http, pause, forward, globals = {}, listeningClock, judgment } = {}) {
    const root = directory(t);
    fs.writeFileSync(path.join(root, 'member-profile.json'), JSON.stringify(p));
    const calls = [], replies = [], logs = [];
    const judgments = [];
    const redisAccess = [], intervals = [], clearedIntervals = [], clearedTimeouts = [];
    const fixtureConfig = mergeConfig(repositoryConfig, pluginConfig);
    fixtureConfig.deepseek.apiKey = 'test-deepseek-key';
    fixtureConfig.webSearch.apiKey = 'test-ollama-key';
    fixtureConfig.profile.file = './member-profile.json';
    fixtureConfig.memory.seedConfigFile = false;
    const redis = new Map(Object.entries({ [`${fixtureConfig.redisKeyPrefix}:historyLength`]: '0', ...config }));
    class TestMemoryService extends MemoryService { start() {} }
    class TestWebService extends WebService { constructor(options) { super({ ...options, sleep: async () => {} }); } }
    class TestConversationListening extends ConversationListening { constructor(options) { super({ ...options, ...(listeningClock ? { now: listeningClock.now, setTimer: listeningClock.setTimer, clearTimer: listeningClock.clearTimer } : {}) }); } }
    const sandbox = { console, URL, Buffer, Date, config: fixtureConfig, setTimeout, clearTimeout: value => { clearedTimeouts.push(value); clearTimeout(value); }, dirname: path.dirname, join: path.join,
        setInterval: (_fn, ms) => { intervals.push(ms); return { unref() {} }; }, clearInterval: value => { clearedIntervals.push(value); },
        readFileSync: fs.readFileSync, writeFileSync: fs.writeFileSync, renameSync: fs.renameSync, existsSync: fs.existsSync, copyFileSync: fs.copyFileSync,
        fileURLToPath, completionMessage, MemoryService: TestMemoryService, MEMORY_RULES, sessionKey, normalizeId, parseJsonObject, WebService: TestWebService, WEB_TOOLS, WEB_RULES, ReplyDelivery, QuotedContinuation, ConversationListening: TestConversationListening, GifContactSheet, REPLY_RULES, planReply, prefersSingleReply, stripInternalReplyMetadata,
        logger: { info() {}, warn() {}, error: (...args) => logs.push(args) }, segment: { at: uid => ({ type: 'at', qq: uid }) },
        common: { sleep: pause || (async () => {}), makeForwardMsg: forward ? (_e, nodes) => forward(nodes) : (async () => []) },
        plugin: class { constructor(options) { this.options = options; } },
        redis: { keys: async pattern => { redisAccess.push(pattern); return startup; }, get: async key => { redisAccess.push(key); return redis.get(key); }, set: async (key, value) => redis.set(key, value) },
        axios: http || { get: async () => { throw Error('network disabled'); }, post: async () => { throw Error('network disabled'); } },
        OpenAI: class { constructor() { this.apiKey = 'test-deepseek-key'; this.chat = { completions: { create: async params => {
            const system = params.messages[0]?.content || '';
            if (system.includes('你是群聊记忆提取器')) return extraction ? extraction(params) : message({ memories: [] });
            if (system.includes('你是对话摘要助手')) return message('滚动摘要');
            if (system.includes('你是群聊接话判断器')) { judgments.push(params); return judgment ? judgment(params, judgments.length) : message({ action: 'silent' }); }
            calls.push(params);
            return response ? response(params, calls.length) : message('正常回复');
        } } }; } }
    };
    Object.assign(sandbox, globals);
    sandbox.global = sandbox;
    vm.createContext(sandbox);
    const code = mainSource.replace(/^import .*;\r?\n/gm, '').replace(/export class /g, 'class ')
        .replaceAll('import.meta.url', JSON.stringify(pathToFileURL(path.join(root, 'index.js')).href));
    vm.runInContext(code + '\nthis.api={DeepSeek,GuaguaGroupNotice,memory,web,replyDelivery,quoteContinuations,conversationListening,gifVision,buildImagesFromSources,buildImageParts,loadProfile,reloadProfile,profileForWrite,saveProfile,executeProfileQuery,profileQueryContext,buildUserContext,daysToBirthday,findByAlias,processCQCode,getQuotedMessage,getRawMessageFromArray};', sandbox);
    const api = sandbox.api;
    api.web.getOllamaKey = () => 'test-ollama-key';
    t.after(() => api.memory.dispose());
    const instance = new api.DeepSeek();
    let id = 0;
    function event(content = '#呱瓜 测试', overrides = {}) {
        const e = { self_id: 12345, group_id: 99999, user_id: 33333, message_id: `m${++id}`, isMaster: true,
            msg: content, raw_message: content, message: [{ type: 'text', text: content }], sender: { nickname: '群员', role: 'member' },
            bot: { uin: 12345, pickMember: () => ({ getInfo: async () => ({ sex: 0 }) }), pickUser: () => ({ getInfo: async () => ({ sex: 0 }), sendMsg: async () => true }), pickGroup: () => ({ getChatHistory: async () => [], getMemberMap: async () => { const table = e.bot.gml?.get?.(Number(e.group_id)) || e.bot.gml?.get?.(String(e.group_id)); if (!table) throw Error('no verified roster'); return table; } }) },
            group: { group_id: 99999, pickMember: () => ({ nickname: '群员' }) }, reply: async body => { replies.push(body); return true; }, ...overrides };
        return e;
    }
    async function dispatch(e, otherRules = []) {
        if (await instance.accept(e) === 'return') return 'accept';
        for (const rule of instance.options.rule) {
            if (!new RegExp(rule.reg).test(e.msg)) continue;
            if (rule.permission === 'master' && !e.isMaster) {
                await e.reply('暂无权限，只有主人才能操作');
                return 'denied';
            }
            if (await instance[rule.fnc](e) !== false) return rule.fnc;
        }
        for (const rule of otherRules) {
            if (!rule.reg.test(e.msg)) continue;
            if (await rule.run(e) !== false) return 'other-plugin';
        }
        return null;
    }
    return { root, api, instance, calls, replies, logs, judgments, event, dispatch, sandbox, redis, redisAccess, intervals, clearedIntervals, clearedTimeouts, pluginConfig: fixtureConfig };
}

export function quotedHarness(t, options = {}) {
    const h = pluginHarness(t, options), sent = [];
    let next = 0;
    function event(content = '#呱瓜 原问题', overrides = {}) {
        const e = h.event(content, overrides), reply = e.reply;
        e.reply = async (payload, quote) => {
            const result = await reply(payload, quote);
            if (result === false || result?.error || result?.status === 'failed') return result;
            const receipt = { message_id: `bot-${++next}` };
            sent.push({ payload, receipt });
            return receipt;
        };
        return e;
    }
    function follow(content, id = sent.at(-1)?.receipt.message_id, overrides = {}) {
        return event(content, { reply_id: id, message: [{ type: 'reply', id }, { type: 'text', text: content }], ...overrides });
    }
    async function receive(e) {
        const result = await h.instance.accept(e);
        await h.api.memory.chains.get(sessionKey(e));
        await turn();
        return result;
    }
    return { ...h, sent, event, follow, receive };
}
