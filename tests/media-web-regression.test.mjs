import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebService } from '../guagua-web.mjs';
import { GifContactSheet } from '../guagua-vision.mjs';
import { tinyGif, rgbaFrames } from './vision-fixtures.mjs';
import { pluginHarness, quotedHarness, message, deferred, turn } from './plugin-harness.mjs';
import { FakeClock } from './fake-clock.mjs';

const dataUrl = bytes => 'data:image/gif;base64,' + bytes.toString('base64');
const imageEvent = (h, extra = {}) => h.event('#呱瓜 看看', { message: [
    { type: 'text', text: '#呱瓜 看看' }, { type: 'image', url: 'https://example.com/current' }
], ...extra });

test('当前附件下载失败会告诉模型未收到图片，不只覆盖引用附件', async t => {
    const h = pluginHarness(t, { http: { get: async () => { throw Error('image unavailable'); } } });
    await h.instance.chat(imageEvent(h));
    const content = h.calls[0].messages.at(-1).content;
    assert.equal(typeof content, 'string');
    assert.match(content, /图片读取状态.*未能读取本次图片.*没有图片数据/s);
});

test('非视觉模型统一说明当前和引用图片不支持，且不发出下载请求', async t => {
    let downloads = 0;
    const h = pluginHarness(t, { config: { 'deepseekJS:model_type': 'deepseek-v4-pro' },
        http: { get: async () => { downloads++; throw Error('must not download'); } } });
    await h.instance.chat(imageEvent(h, { reply_id: 'quoted-image',
        getReply: async () => ({ message: [{ type: 'image', url: 'https://example.com/quoted' }] }) }));
    assert.equal(downloads, 0);
    const content = h.calls[0].messages.at(-1).content;
    assert.equal(typeof content, 'string');
    assert.match(content, /当前模型不支持图片输入/);
    assert.doesNotMatch(content, /未能下载|未能读取本次图片/);
});

test('当前与引用图片部分成功时保留成功图片，不能误称没有收到任何图', async t => {
    for (const broken of ['current', 'quoted']) {
        const gif = tinyGif([10]);
        const h = pluginHarness(t, { http: { get: async src => {
            if (src.endsWith(broken)) throw Error('image unavailable');
            return { data: gif, headers: { 'content-type': 'image/gif' } };
        } } });
        await h.instance.chat(imageEvent(h, { reply_id: 'quote',
            getReply: async () => ({ message: [{ type: 'image', url: 'https://example.com/quoted' }] }) }));
        const content = h.calls[0].messages.at(-1).content;
        assert.equal(content.filter(part => part.type === 'image_url').length, 1);
        assert.match(content[0].text, /已收到1张图片.*另有1张图片未能读取/s);
        assert.doesNotMatch(content[0].text, /本次没有图片数据输入/);
        assert.equal(content.find(part => part.type === 'image_url').image_url.url, dataUrl(gif));
    }
});

test('达到图片额度时明确有引用图被省略，不把额度限制当作下载失败', async t => {
    const downloads = [], gif = tinyGif([10]);
    const h = pluginHarness(t, { http: { get: async src => {
        downloads.push(src); return { data: gif, headers: { 'content-type': 'image/gif' } };
    } } });
    await h.instance.chat(h.event('#呱瓜 看看', { message: [{ type: 'text', text: '#呱瓜 看看' },
        ...Array.from({ length: 4 }, (_, i) => ({ type: 'image', url: 'https://example.com/current-' + i }))],
        reply_id: 'quote', getReply: async () => ({ message: [{ type: 'image', url: 'https://example.com/quoted' }] }) }));
    const content = h.calls[0].messages.at(-1).content;
    assert.equal(downloads.length, 4);
    assert.equal(content.filter(part => part.type === 'image_url').length, 4);
    assert.match(content[0].text, /数量或请求体积限制.*1张图片未附加/s);
    assert.doesNotMatch(content[0].text, /未能读取|未能下载/);
});

test('缺少URL的图片附件提供失败状态而不是悄悄消失', async t => {
    const h = pluginHarness(t);
    await h.instance.chat(h.event('#呱瓜 看看', { message: [{ type: 'text', text: '#呱瓜 看看' }, { type: 'image' }] }));
    assert.match(h.calls[0].messages.at(-1).content, /未能读取本次图片/);
});

test('引用附件缺少来源与超过引用限量时分别交付失败和省略状态', async t => {
    const h = pluginHarness(t);
    await h.instance.chat(h.event('#呱瓜 看看', { reply_id: 'quoted-image', getReply: async () => ({
        message: Array.from({ length: 5 }, () => ({ type: 'image' }))
    }) }));
    const content = h.calls[0].messages.at(-1).content;
    assert.match(content, /未能读取引用图片/);
    assert.doesNotMatch(content, /数量限制/);
    const another = pluginHarness(t, { pluginConfig: { chat: { quotedMaxImages: 4 } } });
    await another.instance.chat(another.event('#呱瓜 看看', { reply_id: 'quoted-image', getReply: async () => ({
        message: Array.from({ length: 5 }, (_, i) => ({ type: 'image', url: dataUrl(tinyGif([10 + i])) }))
    }) }));
    assert.match(another.calls[0].messages.at(-1).content[0].text, /1张图片未附加/);
});

test('合并批次保留显式命令的引用图，并按实际发言人标注引用文字', async t => {
    const gif = tinyGif([10]), downloads = [];
    const h = pluginHarness(t, { http: { get: async src => {
        downloads.push(src); return { data: gif, headers: { 'content-type': 'image/gif' } };
    } } });
    const first = h.event('接着刚才说的', { user_id: 33333 });
    const second = h.event('#呱瓜 这张呢', { user_id: 44444, reply_id: 'quoted-image',
        getReply: async () => ({ sender: { nickname: '原图作者' }, message: [
            { type: 'text', text: '原图说明' }, { type: 'image', url: 'https://example.com/batch-quote' }
        ] }) });
    const token = h.api.memory.token(second);
    token.listenBatch = [first, second].map(event => ({ event, userId: String(event.user_id), raw: event.msg, id: event.message_id }));
    await h.instance.chatUnlocked(second, token);
    const content = h.calls[0].messages.at(-1).content;
    assert.equal(content.filter(part => part.type === 'image_url').length, 1);
    assert.match(content[0].text, /userid=44444 的消息所引用内容（原图作者 发的）.*原图说明/s);
    assert.deepEqual(downloads, ['https://example.com/batch-quote']);
});

test('批次引用图片失败保留真实状态，其他已送达图片不会被误报为未收到', async t => {
    const gif = tinyGif([10]);
    const h = pluginHarness(t, { http: { get: async src => {
        if (src.includes('quote')) throw Error('image unavailable');
        return { data: gif, headers: { 'content-type': 'image/gif' } };
    } } });
    const event = imageEvent(h, { reply_id: 'quoted-image', getReply: async () => ({
        message: [{ type: 'image', url: 'https://example.com/batch-quote' }]
    }) });
    const token = h.api.memory.token(event);
    token.listenBatch = [{ event, userId: String(event.user_id), raw: event.msg, id: event.message_id }];
    await h.instance.chatUnlocked(event, token);
    const content = h.calls[0].messages.at(-1).content;
    assert.equal(content.filter(part => part.type === 'image_url').length, 1);
    assert.match(content[0].text, /已收到1张图片.*另有1张图片未能读取/s);
    assert.doesNotMatch(content[0].text, /本次没有图片数据输入/);
});

test('HTTP、本地、data和base64源均遵守8MiB真实字节限制', async t => {
    const tooLarge = Buffer.alloc(8 * 1024 * 1024 + 1); tooLarge.set([255, 216, 255, 224]);
    const h = pluginHarness(t, { http: { get: async () => ({ data: tooLarge, headers: { 'content-type': 'image/jpeg' } }) } });
    const file = path.join(h.root, 'oversized.jpg'); fs.writeFileSync(file, tooLarge);
    for (const src of ['https://example.com/oversized', file, pathToFileURL(file).href,
        'data:image/jpeg;base64,' + tooLarge.toString('base64'), 'base64://' + tooLarge.toString('base64')]) {
        const parts = await h.api.buildImagesFromSources([src]);
        assert.equal(parts.length, 0);
        assert.equal(parts.delivery.requested, 1);
        assert.equal(parts.delivery.failed, 1);
    }
    const exact = tooLarge.subarray(0, 8 * 1024 * 1024), src = 'data:image/jpeg;base64,' + exact.toString('base64');
    const accepted = await h.api.buildImagesFromSources([src]);
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0].image_url.url, src, '不把base64字符串长度误当原文件字节数');
});

test('图片请求体预算保留完整图片，超出部分标为省略且统计不进入模型序列化', async t => {
    const h = pluginHarness(t), first = dataUrl(tinyGif([10])), second = dataUrl(tinyGif([11]));
    const one = await h.api.buildImagesFromSources([first]);
    const two = await h.api.buildImagesFromSources([first, second], 4, one.delivery.bytes);
    assert.equal(two.length, 1);
    assert.equal(two[0].image_url.url, first);
    assert.equal(two.delivery.attached, 1);
    assert.equal(two.delivery.omitted, 1);
    assert.ok(two.delivery.bytes <= one.delivery.bytes);
    assert.doesNotMatch(JSON.stringify(two), /requested|omitted|delivery/);
});

const uploaded = params => Array.from(Array.isArray(params.messages.at(-1).content) ? params.messages.at(-1).content : []).filter(part => part.type === 'image_url');
const imageLabels = params => {
    const content = params.messages.at(-1).content, result = []; let label = '';
    for (const part of Array.isArray(content) ? content : []) {
        if (part.type === 'text' && part.text.startsWith('【图片来源】')) label = part.text;
        if (part.type === 'image_url') result.push(label);
    }
    return result;
};

test('选中的相关前文同时附加当前图和引用图，每张标原发图人而非当前提问者', async t => {
    const first = dataUrl(tinyGif([10])), second = dataUrl(tinyGif([11]));
    const h = pluginHarness(t);
    const earlier = h.event('原图', { user_id: 33333, message: [{ type: 'image', url: first }],
        reply_id: 'original-quote', getReply: async () => ({ user_id: 55555, message_id: 'source-55555', sender: { nickname: '原作者' },
            message: [{ type: 'image', url: second }] }) });
    const current = h.event('这张图是什么意思', { user_id: 44444 });
    const token = h.api.memory.token(current);
    token.listenBatch = [{ event: current, userId: '44444', raw: current.msg, id: current.message_id }];
    token.listenContext = [{ event: earlier, userId: '33333', raw: '原图[CQ:image]', id: earlier.message_id }];
    await h.instance.chatUnlocked(current, token);
    assert.deepEqual(uploaded(h.calls[0]).map(part => part.image_url.url), [first, second]);
    const labels = imageLabels(h.calls[0]);
    assert.match(labels[0], /选中的相关前文.*发图人userid=33333/);
    assert.match(labels[1], /选中的相关前文.*原发图人userid=55555.*source-55555/);
    assert.deepEqual(Array.from(token.imageRefs, ref => ref.speakerId), ['33333', '55555']);
});

test('多人图片部分失败仍逐来源说明，成功图前的身份标签属于真正发图人', async t => {
    const h = pluginHarness(t, { http: { get: async src => {
        if (src.endsWith('/a')) throw Error('a unavailable');
        return { data: tinyGif([10]), headers: { 'content-type': 'image/gif' } };
    } } });
    const batch = [33333, 44444].map((user_id, i) => {
        const event = h.event('看看我的图', { user_id, message: [{ type: 'image', url: 'https://example.com/' + (i ? 'b' : 'a') }] });
        return { event, userId: String(user_id), raw: '看看我的图[CQ:image]', id: event.message_id };
    });
    const token = h.api.memory.token(batch[1].event); token.listenBatch = batch;
    await h.instance.chatUnlocked(batch[1].event, token);
    assert.equal(uploaded(h.calls[0]).length, 1);
    assert.match(imageLabels(h.calls[0])[0], /发图人userid=44444/);
    assert.match(h.calls[0].messages.at(-1).content[0].text, /未能读取：[^\n]*发图人userid=33333/);
    const failed = token.imageRefs.find(ref => ref.speakerId === '33333');
    assert.equal(failed.src, undefined);
    assert.equal(failed.unavailable, true);
    assert.match(failed.unavailableReason, /未能读取/);
});

test('缺失附件夹在有效图片之前时，失败和成功的原消息图片序号不交换', async t => {
    const image = dataUrl(tinyGif([10])), h = pluginHarness(t);
    await h.instance.chat(h.event('#呱瓜 看看', { message: [
        { type: 'text', text: '#呱瓜 看看' }, { type: 'image' }, { type: 'image', url: image }
    ] }));
    assert.equal(uploaded(h.calls[0]).length, 1);
    assert.match(imageLabels(h.calls[0])[0], /第2张图/);
    assert.match(h.calls[0].messages.at(-1).content[0].text, /未能读取：[^\n]*第1张图/);
});

test('同一图片URL由不同成员发送仍分别标注，只有同条消息的重复来源合并', async t => {
    const h = pluginHarness(t), image = dataUrl(tinyGif([10]));
    const batch = [33333, 44444].map(user_id => {
        const event = h.event('看看我的图', { user_id, message: [{ type: 'image', url: image }] });
        return { event, userId: String(user_id), raw: '看看我的图[CQ:image]', id: event.message_id };
    });
    const token = h.api.memory.token(batch[1].event); token.listenBatch = batch; token.listenContext = [batch[0]];
    await h.instance.chatUnlocked(batch[1].event, token);
    assert.equal(uploaded(h.calls[0]).length, 2, '不能按相同URL合并不同发图人，也不能重复上传同条选中前文');
    assert.match(imageLabels(h.calls[0])[0], /userid=33333/);
    assert.match(imageLabels(h.calls[0])[1], /userid=44444/);
});

test('四张额度内外交付都保留各自身份，省略的第五位不会冒用前面图', async t => {
    const h = pluginHarness(t), batch = Array.from({ length: 5 }, (_, i) => {
        const event = h.event('我的图', { user_id: 33330 + i, message: [{ type: 'image', url: dataUrl(tinyGif([10 + i])) }] });
        return { event, userId: String(event.user_id), raw: '我的图[CQ:image]', id: event.message_id };
    });
    const token = h.api.memory.token(batch[4].event); token.listenBatch = batch;
    await h.instance.chatUnlocked(batch[4].event, token);
    assert.equal(uploaded(h.calls[0]).length, 4);
    assert.match(h.calls[0].messages.at(-1).content[0].text, /未附加：[^\n]*userid=33334[^\n]*数量限制/);
    assert.equal(token.imageRefs[4].unavailable, true);
    assert.equal(token.imageRefs[4].src, undefined);
});

test('unavailable不占四张图片额度，有效图在大量失败元数据后仍送达并优先保留到后续', async t => {
    const h = pluginHarness(t), image = dataUrl(tinyGif([10]));
    const current = h.event('接着看图'), token = h.api.memory.token(current);
    token.listenBatch = [{ event: current, userId: '33333', raw: current.msg, id: current.message_id }];
    token.listenerImages = [...Array.from({ length: 8 }, (_, i) => ({ speakerId: '44444', messageId: 'missing-' + i,
        origin: 'current', unavailable: true, unavailableReason: '图片来源缓存容量限制', label: '失效原图' + i })),
        { src: image, speakerId: '55555', messageId: 'available', origin: 'current', label: '有效原图userid=55555' }];
    await h.instance.chatUnlocked(current, token);
    assert.deepEqual(uploaded(h.calls[0]).map(part => part.image_url.url), [image]);
    assert.equal(token.imageRefs.length, 8);
    assert.equal(token.imageRefs[0].src, image);
    assert.equal(token.imageRefs[0].speakerId, '55555');
});

test('临时读取失败可继续尝试后续图片，但整轮最多八次真实下载', async t => {
    let requests = 0;
    const h = pluginHarness(t, { http: { get: async () => { requests++; throw Error('unavailable'); } } });
    const parts = await h.api.buildImagesFromSources(Array.from({ length: 20 }, (_, i) => 'https://example.com/' + i));
    assert.equal(requests, 8);
    assert.equal(parts.delivery.failed, 8);
    assert.equal(parts.delivery.omitted, 12);
    assert.ok(Array.from(parts.items).slice(8).every(item => item.reason === '图片下载尝试次数限制'));
});

test('引用原图后的有效续聊再次上传原图，其他群员接话也不继承图片所有权', async t => {
    const image = dataUrl(tinyGif([10])), h = quotedHarness(t);
    await h.instance.chat(h.event('#呱瓜 看看引用的图', { reply_id: 'source-image', getReply: async () => ({
        user_id: 55555, message_id: 'source-image', sender: { nickname: '原发图人' }, message: [{ type: 'image', url: image }]
    }) }));
    assert.equal(uploaded(h.calls[0]).length, 1);
    await h.receive(h.follow('原图右下角是什么', undefined, { user_id: 44444 }));
    assert.equal(h.calls.length, 2);
    assert.deepEqual(uploaded(h.calls[1]).map(part => part.image_url.url), [image]);
    assert.match(imageLabels(h.calls[1])[0], /原发图人userid=55555.*source-image/);
    assert.doesNotMatch(imageLabels(h.calls[1])[0], /发图人userid=44444/);
});

test('普通限时后续利用话题保留的原图，而非只有附图计数历史', async t => {
    const clock = new FakeClock(), image = dataUrl(tinyGif([10]));
    const h = quotedHarness(t, { listeningClock: clock, judgment: params => {
        const input = JSON.parse(params.messages[1].content);
        return message({ action: 'reply', message_ids: input.messages.map(item => item.id) });
    } });
    await h.instance.chat(h.event('#呱瓜 看看', { message: [{ type: 'text', text: '#呱瓜 看看' }, { type: 'image', url: image }] }));
    await h.instance.accept(h.event('刚才图里的字是什么'));
    await clock.advance(8000);
    assert.equal(h.calls.length, 2);
    assert.deepEqual(uploaded(h.calls[1]).map(part => part.image_url.url), [image]);
    assert.match(imageLabels(h.calls[1])[0], /本话题之前实际回应.*发图人userid=33333/);
});

test('多轮引用或普通后续始终重建扁平图片来源，原作者与原消息id不会被递归前缀截掉', async t => {
    for (const mode of ['quote', 'plain']) {
        const clock = new FakeClock(), image = dataUrl(tinyGif([10]));
        const h = quotedHarness(t, { listeningClock: clock, judgment: params => message({ action: 'reply',
            message_ids: JSON.parse(params.messages[1].content).messages.map(item => item.id) }) });
        const initial = h.event('#呱瓜 看图', { message: [{ type: 'image', url: image }] });
        await h.instance.chat(initial);
        const lengths = [];
        for (let i = 0; i < 12; i++) {
            if (mode === 'quote') await h.receive(h.follow('接着说原图'));
            else { await h.instance.accept(h.event('接着说原图')); await clock.advance(8000); }
            const label = imageLabels(h.calls.at(-1))[0];
            assert.match(label, /原发图人userid=33333/);
            assert.ok(label.includes('原消息id=' + initial.message_id));
            assert.ok(label.length < 250);
            lengths.push(label.length);
        }
        assert.equal(new Set(lengths).size, 1);
    }
});

test('再次引用旧回执及显式命令引用旧回执只取旧图，不使用window最新图片', async t => {
    for (const explicit of [false, true]) {
        const a = dataUrl(tinyGif([10])), b = dataUrl(tinyGif([11])), h = quotedHarness(t);
        await h.instance.chat(h.event('#呱瓜 第一张', { message: [{ type: 'text', text: '#呱瓜 第一张' }, { type: 'image', url: a }] }));
        const oldId = h.sent[0].receipt.message_id;
        await h.receive(h.follow('再看新图', oldId, { message: [{ type: 'reply', id: oldId }, { type: 'text', text: '再看新图' }, { type: 'image', url: b }] }));
        assert.equal(uploaded(h.calls[1]).length, 2);
        const third = h.follow(explicit ? '#呱瓜 只说原来那张' : '只说原来那张', oldId,
            { getReply: async () => ({ sender: { nickname: '呱瓜' }, message: [{ type: 'text', text: '机器人之前的文字回答' }] }) });
        if (explicit) await h.instance.chat(third); else await h.receive(third);
        assert.equal(h.calls.length, 3);
        assert.deepEqual(uploaded(h.calls[2]).map(part => part.image_url.url), [a]);
    }
});

test('旧回执images为空时不回退到window最新图，显式引用与自动续聊均如此', async t => {
    for (const explicit of [false, true]) {
        const image = dataUrl(tinyGif([10])), h = quotedHarness(t);
        await h.instance.chat(h.event('#呱瓜 只有文字的原问题'));
        const oldId = h.sent[0].receipt.message_id;
        await h.receive(h.follow('新图', oldId, { message: [{ type: 'reply', id: oldId }, { type: 'image', url: image }] }));
        const old = h.follow(explicit ? '#呱瓜 原来的文字是什么' : '原来的文字是什么', oldId,
            { getReply: async () => ({ message: [{ type: 'text', text: '只有文字' }] }) });
        if (explicit) await h.instance.chat(old); else await h.receive(old);
        assert.equal(h.calls.length, 3);
        assert.equal(uploaded(h.calls[2]).length, 0);
    }
});

test('适配器不能getReply时显式空前缀引用仍采用本地回执原图，不误报引用内容不可用', async t => {
    const image = dataUrl(tinyGif([10])), h = quotedHarness(t);
    await h.instance.chat(h.event('#呱瓜 图', { message: [{ type: 'image', url: image }] }));
    const id = h.sent[0].receipt.message_id;
    await h.instance.chat(h.follow('#呱瓜', id));
    assert.equal(uploaded(h.calls[1]).length, 1);
    const text = h.calls[1].messages.at(-1).content[0].text;
    assert.doesNotMatch(text, /当前未能取得可用的引用内容|不要假装看过图片/);
});

test('合并批次各引用分别保留原回执的图，附带的新图也标明新发图人', async t => {
    const a = dataUrl(tinyGif([10])), b = dataUrl(tinyGif([11])), c = dataUrl(tinyGif([12])), h = quotedHarness(t);
    await h.instance.chat(h.event('#呱瓜 A', { message: [{ type: 'image', url: a }] }));
    const idA = h.sent[0].receipt.message_id;
    await h.instance.chat(h.event('#呱瓜 B', { user_id: 44444, message: [{ type: 'image', url: b }] }));
    const idB = h.sent.at(-1).receipt.message_id;
    const first = h.follow('这张A', idA), second = h.follow('这张B和我的新图', idB, { user_id: 55555,
        message: [{ type: 'reply', id: idB }, { type: 'text', text: '这张B和我的新图' }, { type: 'image', url: c }] });
    const batch = [first, second].map(event => ({ event, userId: String(event.user_id), raw: event.msg,
        id: event.message_id, reference: h.instance.quotedFollowup(event) }));
    const token = h.api.memory.token(second); token.listenBatch = batch; token.continuation = batch[1].reference;
    await h.instance.chatUnlocked(second, token);
    assert.deepEqual(uploaded(h.calls[2]).map(part => part.image_url.url), [c, a, b]);
    assert.match(imageLabels(h.calls[2])[0], /发图人userid=55555/);
    assert.match(imageLabels(h.calls[2])[1], /发图人userid=33333/);
    assert.match(imageLabels(h.calls[2])[2], /发图人userid=44444/);
});

test('原图来源因缓存限额被删除时逐来源报告，保留unavailable而不假称看到原图', async t => {
    const h = quotedHarness(t), image = dataUrl(tinyGif([10]));
    await h.instance.chat(h.event('#呱瓜 图', { message: [{ type: 'image', url: image }] }));
    const window = [...h.api.quoteContinuations.windows.values()].at(-1), id = h.sent[0].receipt.message_id;
    window.receipts.get(id).images = [{ speakerId: '33333', speakerName: '发图人', messageId: 'original-image', origin: 'current',
        label: '发图人userid=33333，原消息id=original-image', unavailable: true, unavailableReason: '图片来源缓存容量限制' }];
    await h.receive(h.follow('看原图', id));
    assert.equal(uploaded(h.calls[1]).length, 0);
    assert.match(h.calls[1].messages.at(-1).content, /未能读取：[^\n]*userid=33333[^\n]*original-image[^\n]*图片来源缓存容量限制/);
});

test('当前图片下载中取消后不启动下一张下载，也不调用模型', async t => {
    const started = deferred(), release = deferred(), downloads = [];
    const h = pluginHarness(t, { http: { get: async url => {
        downloads.push(url); if (downloads.length === 1) { started.resolve(); await release.promise; }
        return { data: tinyGif([10]), headers: { 'content-type': 'image/gif' } };
    } } });
    const event = h.event('#呱瓜 看看', { message: [{ type: 'image', url: 'https://example.com/one' }, { type: 'image', url: 'https://example.com/two' }] });
    const task = h.instance.chat(event);
    await started.promise; h.api.memory.invalidate(event); release.resolve(); await task;
    assert.deepEqual(downloads, ['https://example.com/one']);
    assert.equal(h.calls.length, 0);
});

test('GIF解码中取消允许已启动解码结束，但不下载后续图或发送回复', async t => {
    const started = deferred(), release = deferred(), downloads = [];
    const h = pluginHarness(t, { http: { get: async url => {
        downloads.push(url); return { data: tinyGif([10, 10]), headers: { 'content-type': 'image/gif' } };
    } } });
    h.api.gifVision.decoder = async (_bytes, indices, cell) => { started.resolve(); await release.promise; return rgbaFrames(indices, cell); };
    const event = h.event('#呱瓜 看看', { message: [{ type: 'image', url: 'https://example.com/one' }, { type: 'image', url: 'https://example.com/two' }] });
    const task = h.instance.chat(event);
    await started.promise; h.api.memory.invalidate(event); release.resolve(); await task;
    assert.deepEqual(downloads, ['https://example.com/one']); assert.equal(h.calls.length, 0);
});

test('被取消的GIF排队消费者不启动解码、不污染失败缓存；同图有效消费者可以继续', async t => {
    for (const shared of [false, true]) {
        const gates = []; let valid = true;
        const service = new GifContactSheet({ cell: 64, logger: { warn() {} }, decoder: async (_bytes, indices, cell) => {
            const gate = deferred(); gates.push(gate); await gate.promise; return rgbaFrames(indices, cell);
        } });
        t.after(() => service.dispose());
        const tasks = [10, 11].map(delay => service.prepare(dataUrl(tinyGif([delay, delay]))));
        for (let i = 0; i < 100 && gates.length < 2; i++) await turn();
        const source = dataUrl(tinyGif([12, 12]));
        const cancelled = service.prepare(source, { valid: () => valid }); tasks.push(cancelled);
        if (shared) tasks.push(service.prepare(source));
        for (let i = 0; i < 100 && service.waiters.length < 1; i++) await turn();
        valid = false;
        for (let i = 0; i < 20; i++) { for (const gate of gates) gate.resolve(); await turn(); }
        const results = await Promise.all(tasks);
        assert.equal(gates.length, shared ? 3 : 2);
        assert.equal(results[2].fallback, true);
        if (shared) assert.equal(results[3].fallback, false);
        assert.equal(service.failures.size, 0); assert.equal(service.running, 0);
    }
});

test('全部GIF消费者解码中取消后，成功与异常均不写新缓存，下一有效请求重新解码', async t => {
    for (const fails of [false, true]) {
        const started = deferred(), release = deferred(); let valid = true, decodes = 0, saves = 0;
        const service = new GifContactSheet({ cell: 64, logger: { warn() {} }, decoder: async (_bytes, indices, cell) => {
            decodes++;
            if (decodes === 1) { started.resolve(); await release.promise; if (fails) throw Error('decoder failed after cancellation'); }
            return rgbaFrames(indices, cell);
        } });
        service.save = async () => { saves++; };
        t.after(() => service.dispose());
        const source = dataUrl(tinyGif([10, 10])), task = service.prepare(source, { valid: () => valid });
        await started.promise; valid = false; release.resolve();
        assert.equal((await task).fallback, true);
        assert.equal(service.cache.size, 0); assert.equal(service.failures.size, 0); assert.equal(saves, 0);
        const next = await service.prepare(source);
        assert.equal(next.fallback, false); assert.equal(decodes, 2); assert.equal(saves, 1);
    }
});

function webHarness({ post, sleep = async () => {}, now = () => 0 } = {}) {
    let requests = 0;
    const web = new WebService({ http: { post: async (...args) => { requests++; return post(...args); } },
        getDeepSeekKey: () => 'test-key', logger: { warn() {} }, sleep, now });
    return { web, requests: () => requests };
}

test('失效会话在入队前停止，不发出任何网页HTTP请求', async () => {
    const { web, requests } = webHarness({ post: async () => ({ data: { results: [] } }) });
    const result = JSON.parse(await web.execute('web_search', { query: 'doc' }, web.createSession('doc', { valid: () => false })));
    assert.equal(result.error.code, 'cancelled');
    assert.equal(requests(), 0);
});

test('取消后网络错误不再触发自动重试', async () => {
    const started = deferred(), pending = deferred(); let valid = true;
    const { web, requests } = webHarness({ post: () => { started.resolve(); return pending.promise; } });
    const task = web.execute('web_search', { query: 'doc' }, web.createSession('doc', { valid: () => valid }));
    await started.promise; valid = false; pending.reject(Error('network timeout'));
    const result = JSON.parse(await task);
    assert.equal(result.error.code, 'cancelled');
    assert.equal(requests(), 1);
});

test('排队限速等待期间取消，真正启动时不再发请求', async () => {
    const waiting = deferred(), release = deferred(); let valid = true;
    const { web, requests } = webHarness({ post: async () => ({ data: { results: [] } }),
        sleep: async () => { waiting.resolve(); await release.promise; } });
    await web.execute('web_search', { query: 'first' });
    const task = web.execute('web_search', { query: 'second' }, web.createSession('second', { valid: () => valid }));
    await waiting.promise; valid = false; release.resolve();
    assert.equal(JSON.parse(await task).error.code, 'cancelled');
    assert.equal(requests(), 1);
});

test('重试退避等待期间取消，等待结束后不再启动第二次请求', async () => {
    const waiting = deferred(), release = deferred(); let valid = true;
    const { web, requests } = webHarness({ post: async () => { throw { response: { status: 500 } }; },
        sleep: async () => { waiting.resolve(); await release.promise; } });
    const task = web.execute('web_search', { query: 'doc' }, web.createSession('doc', { valid: () => valid }));
    await waiting.promise; valid = false; release.resolve();
    assert.equal(JSON.parse(await task).error.code, 'cancelled');
    assert.equal(requests(), 1);
});

test('已开始的请求取消后可以完成，但不缓存也不把结果当成有效资料', async () => {
    const started = deferred(), pending = deferred(); let valid = true;
    const { web } = webHarness({ post: () => { started.resolve(); return pending.promise; } });
    const session = web.createSession('doc', { valid: () => valid });
    const task = web.execute('web_fetch', { url: 'https://example.com/doc' }, session);
    await started.promise; valid = false; pending.resolve({ data: { title: 'late', content: 'late page' } });
    assert.equal(JSON.parse(await task).error.code, 'cancelled');
    assert.equal(session.cache.size, 0);
    assert.equal(session.usedChars, 0);
});

test('GIF许可交接期间缓存完成的新任务不能抢槽，最多两个解码任务', async t => {
    const gates = [], disk = deferred(); let loadCount = 0, active = 0, maximum = 0;
    const service = new GifContactSheet({ cell: 64, logger: { warn() {} }, decoder: async (_bytes, indices, cell) => {
        active++; maximum = Math.max(maximum, active);
        const gate = deferred(); gates.push(gate); await gate.promise; active--; return rgbaFrames(indices, cell);
    } });
    t.after(() => service.dispose());
    service.load = () => ++loadCount === 4 ? disk.promise : Promise.resolve(null);
    const tasks = [10, 11, 12].map(delay => service.prepare(dataUrl(tinyGif([delay, delay]))));
    for (let i = 0; i < 100 && (gates.length < 2 || service.waiters.length < 1); i++) await turn();
    assert.equal(gates.length, 2); assert.equal(service.waiters.length, 1);
    tasks.push(service.prepare(dataUrl(tinyGif([13, 13]))));
    await turn();
    // 模拟缓存I/O恰在释放许可与等待任务恢复之间完成。
    const wake = service.waiters[0]; service.waiters[0] = granted => { disk.resolve(null); wake(granted); };
    gates[0].resolve();
    for (let i = 0; i < 20; i++) { for (const gate of gates) gate.resolve(); await turn(); }
    const results = await Promise.all(tasks);
    assert.equal(maximum, 2);
    assert.ok(results.every(result => !result.fallback));
    assert.equal(service.running, 0);
});

test('GIF队列停止时唤醒任务不获得假许可，运行和等待计数最终归零', async t => {
    const gates = [];
    const service = new GifContactSheet({ cell: 64, logger: { warn() {} }, decoder: async (_bytes, indices, cell) => {
        const gate = deferred(); gates.push(gate); await gate.promise; return rgbaFrames(indices, cell);
    } });
    t.after(() => service.dispose());
    const tasks = [10, 11, 12].map(delay => service.prepare(dataUrl(tinyGif([delay, delay]))));
    for (let i = 0; i < 100 && (gates.length < 2 || service.waiters.length < 1); i++) await turn();
    service.dispose();
    for (const gate of gates) gate.resolve();
    assert.ok((await Promise.all(tasks)).every(result => result.fallback));
    assert.equal(service.running, 0);
    assert.equal(service.waiters.length, 0);
    assert.equal(service.cache.size, 0);
});
