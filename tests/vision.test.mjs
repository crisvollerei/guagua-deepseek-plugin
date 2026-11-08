import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { GifContactSheet, readGifTimeline } from '../guagua-vision.mjs';
import { tinyGif, disposalGif, rgbaFrames, readSheet, ffmpeg } from './vision-fixtures.mjs';

const quiet = { warn() {} };
const url = (bytes, mime = 'image/gif') => `data:${mime};base64,${bytes.toString('base64')}`;
function processor(t, options = {}) {
    const service = new GifContactSheet({ logger: quiet, cell: 64, ...options });
    t.after(() => service.dispose());
    return service;
}
async function directory(t) {
    const base = path.resolve('tests/.tmp'); await fs.mkdir(base, { recursive: true });
    const root = await fs.mkdtemp(path.join(base, 'guagua-vision-test-'));
    t.after(async () => { assert.equal(path.dirname(path.resolve(root)), base); await fs.rm(root, { recursive: true, force: true }); });
    return root;
}

test('GIF时间轴读取实际逐帧延时，单帧与损坏文件可区分', () => {
    const timeline = readGifTimeline(tinyGif([5, 20, 10]));
    assert.deepEqual(timeline.frames.map(frame => [frame.index, frame.time, frame.delay]), [[0, 0, 50], [1, 50, 200], [2, 250, 100]]);
    assert.equal(timeline.duration, 350);
    assert.equal(readGifTimeline(tinyGif([10])).frames.length, 1);
    assert.throws(() => readGifTimeline(tinyGif().subarray(0, 30)), /GIF/);
});

test('普通图片逐字保留原数据，不调用解码；单帧GIF也不生成拼图', async t => {
    let calls = 0;
    const service = processor(t, { decoder: async () => { calls++; throw Error('should not decode'); } });
    for (const dataUrl of ['data:image/png;base64,iVBORw0KGgo=', 'data:image/jpeg;base64,/9j/4AAQ', url(tinyGif([10])), url(tinyGif([10]), 'image/png')]) {
        const result = await service.prepare(dataUrl);
        assert.equal(result.dataUrl, dataUrl); assert.equal(result.note, ''); assert.equal(result.animated, false);
    }
    assert.equal(calls, 0);
});

test('按文件签名识别错误后缀的GIF，默认六帧按2列3行排序并保留透明合成背景', async t => {
    const service = processor(t, { decoder: async (_bytes, selected, cell) => rgbaFrames(selected, cell) });
    const result = await service.prepare(url(tinyGif(), 'image/png'));
    assert.equal(result.animated, true); assert.equal(result.fallback, false);
    assert.match(result.note, /6个采样帧.*2列×3行/);
    const sheet = readSheet(result.dataUrl);
    assert.equal(sheet.width, 152); assert.equal(sheet.height, 296);
    const expected = [[240,10,10], [10,240,10], [10,10,240], [240,240,10], [10,240,240], [240,10,240]];
    for (let slot = 0; slot < 6; slot++) assert.deepEqual(sheet.pixel(8 + (slot % 2) * 72 + 32, 8 + Math.floor(slot / 2) * 96 + 32).slice(0, 3), expected[slot]);
    assert.deepEqual(sheet.pixel(0, 0), [255, 255, 255, 255]);
    let labels = 0;
    for (let x = 8; x < 72; x++) if (sheet.pixel(x, 8 + 64 + 5).slice(0, 3).every(value => value === 24)) labels++;
    assert.ok(labels > 0);
});

test('少于六帧仍输出六个时间采样格，并正确将透明像素合到白底', async t => {
    const service = processor(t, { decoder: async (_bytes, selected, cell) => {
        const bytes = rgbaFrames(selected, cell); bytes.fill(0, 0, cell * cell * 4); return bytes;
    } });
    const result = await service.prepare(url(tinyGif([10, 20])));
    const sheet = readSheet(result.dataUrl);
    assert.deepEqual(sheet.pixel(40, 40), [255, 255, 255, 255]);
    assert.equal(sheet.height, 296);
});

test('内容相同并发处理只解码一次，内存缓存及七天期限生效', async t => {
    let count = 0, now = Date.now();
    const service = processor(t, { now: () => now, decoder: async (_bytes, selected, cell) => { count++; await new Promise(resolve => setImmediate(resolve)); return rgbaFrames(selected, cell); } });
    const input = url(tinyGif());
    const results = await Promise.all(Array.from({ length: 5 }, () => service.prepare(input)));
    assert.equal(count, 1);
    assert.ok(results.every(result => result.dataUrl === results[0].dataUrl));
    await service.prepare(input); assert.equal(count, 1);
    now += 7 * 86400000;
    await service.prepare(input); assert.equal(count, 2);
});

test('磁盘缓存跨实例复用，内容损坏会重新生成且不会污染正常输出', async t => {
    const root = await directory(t); let count = 0;
    const decoder = async (_bytes, selected, cell) => { count++; return rgbaFrames(selected, cell); };
    const first = processor(t, { directory: root, decoder });
    const input = url(tinyGif()), original = await first.prepare(input);
    const second = processor(t, { directory: root, decoder });
    assert.equal((await second.prepare(input)).dataUrl, original.dataUrl); assert.equal(count, 1);
    const image = (await fs.readdir(root)).find(name => name.endsWith('.png'));
    await fs.writeFile(path.join(root, image), 'broken');
    const third = processor(t, { directory: root, decoder });
    assert.equal((await third.prepare(input)).dataUrl, original.dataUrl); assert.equal(count, 2);
    assert.equal((await fs.readdir(root)).some(name => name.endsWith('.tmp')), false);
});

test('缓存不能写入时仍正常返回拼图；解码失败回退原图并短暂缓存失败', async t => {
    const root = await directory(t), blocked = path.join(root, 'file'); await fs.writeFile(blocked, 'occupied');
    const service = processor(t, { directory: blocked, decoder: async (_bytes, selected, cell) => rgbaFrames(selected, cell) });
    assert.equal((await service.prepare(url(tinyGif()))).fallback, false);
    let count = 0, now = Date.now();
    const broken = processor(t, { now: () => now, decoder: async () => { count++; throw Error('no decoder'); } });
    const input = url(tinyGif());
    const result = await broken.prepare(input);
    assert.equal(result.dataUrl, input); assert.equal(result.fallback, true); assert.match(result.note, /仅展示首帧/);
    await broken.prepare(input); assert.equal(count, 1);
    now += 60000; await broken.prepare(input); assert.equal(count, 2);
    const corrupt = url(Buffer.from('GIF89abroken'));
    assert.equal((await broken.prepare(corrupt)).dataUrl, corrupt);
});

test('不同动图最多两个并发解码，停止后不保存迟到结果', async t => {
    let running = 0, max = 0;
    const service = processor(t, { decoder: async (_bytes, selected, cell) => {
        max = Math.max(max, ++running); await new Promise(resolve => setImmediate(resolve)); running--; return rgbaFrames(selected, cell);
    } });
    await Promise.all([10, 11, 12, 13, 14].map(delay => service.prepare(url(tinyGif([delay, delay])))));
    assert.equal(max, 2);
    service.dispose();
    const input = url(tinyGif([12, 34]));
    assert.equal((await service.prepare(input)).dataUrl, input);
    assert.equal(service.cache.size, 0);
});

test('真实FFmpeg解码生成有顺序的六色拼图，默认尺寸为六帧2×3', async t => {
    let gif;
    try { gif = await ffmpeg(['-hide_banner', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', '24x24', '-r', '5', '-i', 'pipe:0', '-frames:v', '6', '-f', 'gif', 'pipe:1'], rgbaFrames([0,1,2,3,4,5], 24)); }
    catch (error) { if (error.code === 'ENOENT') { t.skip('FFmpeg未安装'); return; } throw error; }
    const service = processor(t, { cell: 320 });
    const result = await service.prepare(url(gif));
    assert.equal(result.fallback, false);
    const sheet = readSheet(result.dataUrl);
    assert.equal(sheet.width, 664); assert.equal(sheet.height, 1064);
    const expected = [[true,false,false], [false,true,false], [false,false,true], [true,true,false], [false,true,true], [true,false,true]];
    for (let slot = 0; slot < 6; slot++) {
        const rgb = sheet.pixel(168 + (slot % 2) * 328, 168 + Math.floor(slot / 2) * 352).slice(0, 3);
        assert.deepEqual(rgb.map(value => value > 150), expected[slot]);
    }
    const timeout = processor(t, { timeoutMs: 0 });
    assert.equal((await timeout.prepare(url(gif))).fallback, true);
    assert.equal(timeout.children.size, 0);
});

test('真实增量帧与恢复背景的GIF按完整画面合成，不能把局部块直接当整张图', async t => {
    const service = processor(t);
    const result = await service.prepare(url(disposalGif()));
    if (result.fallback && !process.env.GUAGUA_REQUIRE_FFMPEG) {
        try { await ffmpeg(['-version']); } catch (error) { if (error.code === 'ENOENT') { t.skip('FFmpeg未安装'); return; } }
    }
    assert.equal(result.fallback, false);
    const sheet = readSheet(result.dataUrl);
    assert.deepEqual(sheet.pixel(24, 40).slice(0, 3), [255,0,0]);
    assert.deepEqual(sheet.pixel(56, 40).slice(0, 3), [0,0,255]);
    assert.deepEqual(sheet.pixel(96, 232).slice(0, 3), [0,0,255]);
    assert.deepEqual(sheet.pixel(128, 232).slice(0, 3), [255,0,0]);
});

test('缓存清理限制份数、删除过期配对文件，并保留不属于缓存的文件', async t => {
    const root = await directory(t), now = Date.now();
    await fs.writeFile(path.join(root, 'keep-me.png'), 'keep');
    for (let i = 0; i < 130; i++) {
        const key = i.toString(16).padStart(64, '0');
        await fs.writeFile(path.join(root, `${key}.png`), 'cached');
        await fs.writeFile(path.join(root, `${key}.json`), '{}');
    }
    const expired = '0'.repeat(64), old = new Date(now - 8 * 86400000);
    await fs.utimes(path.join(root, `${expired}.png`), old, old);
    await processor(t, { directory: root, now: () => now }).prune();
    const files = await fs.readdir(root);
    assert.equal(files.filter(name => /^[a-f0-9]{64}\.png$/.test(name)).length, 128);
    assert.equal(files.includes(`${expired}.png`), false);
    assert.equal(files.includes(`${expired}.json`), false);
    assert.equal(await fs.readFile(path.join(root, 'keep-me.png'), 'utf8'), 'keep');
});

test('解码过程被停止后不写入迟到缓存，缺少FFmpeg时明确回退原图', async t => {
    const root = await directory(t);
    let began, finish;
    const started = new Promise(resolve => { began = resolve; }), pending = new Promise(resolve => { finish = resolve; });
    const service = processor(t, { directory: root, decoder: async (_bytes, selected, cell) => { began(); await pending; return rgbaFrames(selected, cell); } });
    const input = url(tinyGif()), request = service.prepare(input);
    await started; service.dispose(); finish();
    assert.equal((await request).dataUrl, input);
    assert.equal(service.cache.size, 0);
    assert.deepEqual(await fs.readdir(root), []);
    const missing = processor(t, { ffmpeg: path.join(root, 'nonexistent-ffmpeg') });
    const result = await missing.prepare(input);
    assert.equal(result.dataUrl, input); assert.equal(result.fallback, true);
    assert.equal(missing.children.size, 0);
});
