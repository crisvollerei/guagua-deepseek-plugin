import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { config as defaults } from '../config.js';
import { quotedHarness, message, turn } from './plugin-harness.mjs';
import { FakeClock } from './fake-clock.mjs';
import { sessionKey } from '../guagua-memory.mjs';
import { tinyGif } from './vision-fixtures.mjs';

const settings = {
    redisKeyPrefix: 'fixtureBot',
    command: { chatPrefix: '#小舟', adminPrefix: '#管理', reset: '#收尾', memoryCommand: '#mem' },
    persona: { botName: '小舟', master: { name: '测试主人', qq: '' }, preferredUsers: [], groupSettings: [],
        systemPrompt: '测试人设常量：{{botName}}以自然语气和{{masterName}}交流。{{modeDesc}}' }
};
const replyAll = params => {
    const input = JSON.parse(params.messages[1].content);
    return message({ action: 'reply', message_ids: input.messages.map(item => item.id) });
};

test('自定义聊天、管理、重置命令和Redis前缀贯通，不借用默认命名空间', async t => {
    const h = quotedHarness(t, { pluginConfig: settings });
    assert.equal(await h.dispatch(h.event('#管理设置温度 0.4')), 'setTemperature');
    assert.equal(h.redis.get('fixtureBot:temperature'), '0.4');
    assert.equal(await h.dispatch(h.event('#管理切换模型 pro')), 'switchModel');
    assert.equal(h.redis.get('fixtureBot:model_type'), 'deepseek-v4-pro');
    assert.equal(await h.dispatch(h.event('#小舟 你好')), 'chat');
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].model, 'deepseek-v4-pro');
    assert.match(h.calls[0].messages[0].content, /测试人设常量：小舟/);
    assert.match(h.calls[0].messages[0].content, /测试主人/);
    assert.ok(h.api.memory.store.history(sessionKey(h.event()), 3).length);
    assert.equal(await h.dispatch(h.event('#收尾')), 'reset');
    assert.equal(h.api.memory.store.history(sessionKey(h.event()), 3).length, 0);
    assert.ok(h.redisAccess.every(key => !String(key).startsWith('deepseekJS:')));
    assert.ok([...h.redis.keys()].every(key => !key.startsWith('deepseekJS:')));
    assert.equal(await h.dispatch(h.event('#呱瓜 旧命令')), null);
    assert.equal(await h.dispatch(h.event('#ds设置温度 0.6')), null);
    assert.equal(h.calls.length, 1);
});

test('独立自定义记忆命令贯通解析、展示及批量确认，默认命令不混入', async t => {
    const h = quotedHarness(t, { pluginConfig: settings });
    h.api.memory.store.change(data => h.api.memory.store.addTo(data, { type: 'fact', subjectId: '33333',
        scope: { kind: 'person' }, status: 'pending', content: '喜欢测试用的绿色马克杯',
        source: { speakerId: '33333', groupId: '99999', quote: '我喜欢绿色马克杯' } }));
    assert.equal(await h.dispatch(h.event('#mem 待确认')), 'memoryCmd');
    const text = JSON.stringify(h.sent.at(-1).payload);
    assert.match(text, /绿色马克杯/);
    assert.match(text, /#mem/);
    assert.ok(!text.includes('#memory'));
    assert.equal(await h.dispatch(h.event('#mem 确认全部')), 'memoryCmd');
    assert.equal(h.api.memory.store.data.records[0].status, 'confirmed');
    assert.equal(await h.dispatch(h.event('#memX 待确认')), null);
    assert.equal(await h.dispatch(h.event('#memory 待确认')), null);
    assert.equal(h.calls.length, 0);
});

test('自定义记忆和管理命令仍服从master权限', async t => {
    const h = quotedHarness(t, { pluginConfig: settings });
    for (const content of ['#mem 待确认', '#管理设置温度 0.4']) {
        assert.equal(await h.dispatch(h.event(content, { isMaster: false })), 'denied');
    }
    assert.equal(h.redis.has('fixtureBot:temperature'), false);
    assert.equal(h.calls.length, 0);
});

test('自定义入口的短期接话复用原人设，引用和普通补充不要求默认前缀', async t => {
    const clock = new FakeClock();
    const h = quotedHarness(t, { pluginConfig: settings, listeningClock: clock, judgment: replyAll });
    await h.dispatch(h.event('#小舟 说说猫吧'));
    await h.receive(h.follow('那狗呢', undefined, { user_id: 44444 }));
    await h.instance.accept(h.event('还有什么需要注意', { user_id: 44444 }));
    await clock.advance(8000);
    assert.equal(h.calls.length, 3);
    assert.equal(h.judgments.length, 1);
    for (const params of h.calls) assert.match(params.messages[0].content, /测试人设常量：小舟/);
});

test('昵称关键词和旧陪伴模式不会独立开启监听或消耗模型', async t => {
    const clock = new FakeClock();
    const h = quotedHarness(t, { pluginConfig: settings, listeningClock: clock,
        startup: ['fixtureBot:companion:99999', 'deepseekJS:companion:99999'] });
    for (const content of ['小舟', '笨瓜', '呱瓜', '#陪伴开启', '#小舟陪伴开启', '#小舟关闭陪伴']) {
        assert.equal(await h.dispatch(h.event(content)), null);
    }
    await clock.advance(70000); await turn();
    assert.equal(h.calls.length, 0);
    assert.equal(h.judgments.length, 0);
    assert.equal(h.api.conversationListening.sessions.size, 0);
    let handled = 0;
    assert.equal(await h.dispatch(h.event('#陪伴开启'), [{ reg: /^#陪伴开启$/, run: async () => { handled++; } }]), 'other-plugin');
    assert.equal(handled, 1);
});

test('命令前缀里的正则符号按字面匹配，不吞其他插件命令', async t => {
    const custom = { ...settings, command: { chatPrefix: '#舟+', adminPrefix: '#管理+', reset: '#收尾+', memoryCommand: '#mem+' } };
    const h = quotedHarness(t, { pluginConfig: custom });
    assert.equal(await h.dispatch(h.event('#舟 其他插件')), null);
    assert.equal(await h.dispatch(h.event('#管理设置温度 0.4')), null);
    assert.equal(await h.dispatch(h.event('#舟+ 你好')), 'chat');
    assert.equal(await h.dispatch(h.event('#管理+设置温度 0.7')), 'setTemperature');
    assert.equal(h.redis.get('fixtureBot:temperature'), '0.7');
    assert.equal(await h.dispatch(h.event('#mem+ 待确认')), 'memoryCmd');
    assert.equal(await h.dispatch(h.event('#收尾+')), 'reset');
    assert.equal(h.calls.length, 1);
});

test('关闭短期收集仍能正常显式聊天和引用，关闭引用入口不关闭显式聊天', async t => {
    const clock = new FakeClock();
    const h = quotedHarness(t, { pluginConfig: { ...settings, listening: { enabled: false } }, listeningClock: clock });
    await h.dispatch(h.event('#小舟 问个问题'));
    await h.instance.accept(h.event('未明确引用的普通补充'));
    await clock.advance(12000);
    assert.equal(h.calls.length, 1);
    assert.equal(h.judgments.length, 0);
    await h.receive(h.follow('明确引用追问'));
    assert.equal(h.calls.length, 2);
    const disabled = quotedHarness(t, { pluginConfig: { ...settings, quoted: { enabled: false } } });
    await disabled.dispatch(disabled.event('#小舟 问个问题'));
    await disabled.receive(disabled.follow('不应自动触发的引用'));
    assert.equal(disabled.calls.length, 1);
    await disabled.dispatch(disabled.event('#小舟 再问一次'));
    assert.equal(disabled.calls.length, 2);
});

test('自定义聊天前缀的显式引用补记仍使用原作者，不误记到请求者', async t => {
    const sources = [];
    const h = quotedHarness(t, { pluginConfig: settings, extraction: params => {
        sources.push(...JSON.parse(params.messages[1].content).messages);
        return message({ memories: [] });
    } });
    const e = h.event('#小舟 记住这条', { reply_id: 'quoted-fact', getReply: async () => ({
        user_id: 44444, message_id: 'quoted-fact', time: Math.floor(Date.now() / 1000),
        sender: { nickname: '另一位测试成员' }, message: [{ type: 'text', text: '我的猫叫元宝' }]
    }) });
    e.bot.gml = new Map([[99999, new Map([[33333, {}], [44444, {}]])]]);
    assert.equal(await h.dispatch(e), 'chat');
    for (let i = 0; i < 20; i++) {
        if (h.api.memory.extracting) await turn();
        else if (h.api.memory.store.data.observations.length) await h.api.memory.processExtractions();
        else break;
    }
    const quoted = sources.find(source => source.text === '我的猫叫元宝');
    assert.equal(quoted.speakerId, '44444');
    assert.equal(quoted.quoted, true);
    assert.equal(h.calls.length, 1);
});

test('自定义资料关键字和帮助文案使用同一套命令配置', async t => {
    const h = quotedHarness(t, { pluginConfig: { ...settings, command: { ...settings.command, profileKeyword: '档案' } } });
    assert.notEqual(await h.dispatch(h.event('#小舟档案查看 22222')), null);
    assert.equal(h.calls.length, 0);
    assert.match(JSON.stringify(h.sent.at(-1).payload), /主人/);
    assert.equal(await h.dispatch(h.event('#管理帮助')), 'help');
    const help = JSON.stringify(h.sent.at(-1).payload);
    assert.match(help, /#小舟/);
    assert.match(help, /#小舟档案/);
    assert.match(help, /#mem/);
    assert.ok(!help.includes('#呱瓜'));
    assert.ok(!help.includes('#memory'));
});

test('配置称呼长度上限拒绝完整长称呼，不截成另一个人的名字', async t => {
    const h = quotedHarness(t, { pluginConfig: { profile: { maxAliasLen: 3 } }, extraction: params => {
        const source = JSON.parse(params.messages[1].content).messages.find(item => item.text.startsWith('我叫'));
        return message({ memories: source ? [{ type: 'alias', userid: source.speakerId, content: source.text.slice(2),
            scope: 'group', source_id: source.id, evidence: source.text }] : [] });
    } });
    for (const alias of ['星光测试员', '阿星']) {
        await h.dispatch(h.event('#呱瓜 我叫' + alias));
        for (let i = 0; i < 20; i++) {
            if (h.api.memory.extracting) await turn();
            else if (h.api.memory.store.data.observations.length) await h.api.memory.processExtractions();
            else break;
        }
    }
    const aliases = h.api.memory.store.data.records.filter(record => record.type === 'alias');
    assert.equal(aliases.length, 1);
    assert.equal(aliases[0].content, '阿星');
    assert.equal(aliases[0].status, 'pending');
});

test('引用图片数量可配置为零或一，超额来源仍显示未附加而非悄悄丢失', async t => {
    for (const limit of [0, 1]) {
        let downloads = 0;
        const h = quotedHarness(t, { pluginConfig: { chat: { quotedMaxImages: limit } }, http: { get: async () => {
            downloads++; return { data: tinyGif([10]), headers: { 'content-type': 'image/gif' } };
        } } });
        await h.dispatch(h.event('#呱瓜 看看引用', { reply_id: 'three-images', getReply: async () => ({
            user_id: 44444, message_id: 'three-images', message: Array.from({ length: 3 }, (_, i) => ({ type: 'image', url: 'https://example.com/quoted-' + i }))
        }) }));
        const content = h.calls[0].messages.at(-1).content;
        const images = Array.isArray(content) ? content.filter(part => part.type === 'image_url') : [];
        const text = Array.isArray(content) ? content.find(part => part.type === 'text').text : content;
        assert.equal(images.length, limit);
        assert.equal(downloads, limit);
        assert.match(text, /图片读取状态/);
        assert.match(text, new RegExp(`${3 - limit}张图片未附加`));
        assert.doesNotMatch(text, /未能读取引用图片/);
    }
});

test('发布配置保留空的个人名单和占位凭据，不携带本地资料', () => {
    assert.equal(defaults.persona.master.qq, '');
    assert.equal(defaults.persona.preferredUsers.length, 0);
    assert.equal(defaults.persona.groupSettings.length, 0);
    const source = fs.readFileSync(new URL('../config.js', import.meta.url), 'utf8');
    assert.ok(!/sk-[a-f0-9]{24,}/i.test(source), '配置不应包含硬编码API密钥');
    assert.equal(defaults.persona.master.name, '主人');
});
