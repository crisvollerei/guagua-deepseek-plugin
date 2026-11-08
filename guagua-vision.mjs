import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { deflate } from 'node:zlib';
import { promisify } from 'node:util';

const zip = promisify(deflate);
const DAY = 86400000;
const VERSION = 'gif-six-2x3-v1';
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const digest = value => createHash('sha256').update(value).digest('hex');
const isGif = bytes => /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'));

export function readGifTimeline(bytes) {
    if (!isGif(bytes) || bytes.length < 14) throw Error('GIF头不完整');
    const width = bytes.readUInt16LE(6), height = bytes.readUInt16LE(8);
    if (!width || !height || width * height > 16777216) throw Error('GIF画布大小不适合处理');
    let at = 13 + ((bytes[10] & 128) ? 3 * (2 ** ((bytes[10] & 7) + 1)) : 0);
    let delay = 100, duration = 0, ended = false;
    const frames = [];
    const subBlocks = () => {
        for (;;) {
            if (at >= bytes.length) throw Error('GIF数据块不完整');
            const length = bytes[at++];
            if (!length) return;
            at += length;
            if (at > bytes.length) throw Error('GIF数据块越界');
        }
    };
    while (at < bytes.length) {
        const kind = bytes[at++];
        if (kind === 0x3b) { ended = true; break; }
        if (kind === 0x21) {
            const extension = bytes[at++];
            if (extension === 0xf9) {
                if (bytes[at++] !== 4 || at + 5 > bytes.length) throw Error('GIF控制块不完整');
                delay = bytes.readUInt16LE(at + 1) * 10 || 100;
                at += 4;
                if (bytes[at++] !== 0) throw Error('GIF控制块缺少结束符');
            } else subBlocks();
        } else if (kind === 0x2c) {
            if (at + 9 > bytes.length) throw Error('GIF帧描述不完整');
            const packed = bytes[at + 8];
            at += 9 + ((packed & 128) ? 3 * (2 ** ((packed & 7) + 1)) : 0);
            if (at >= bytes.length) throw Error('GIF帧不完整');
            at++; // LZW 最小码宽；像素及增量帧合成由 FFmpeg 负责。
            subBlocks();
            frames.push({ index: frames.length, time: duration, delay });
            duration += delay;
            delay = 100;
        } else throw Error('GIF包含未知数据块');
    }
    if (!ended || !frames.length) throw Error('GIF缺少有效帧或结束符');
    return { width, height, duration, frames };
}

function samples(timeline) {
    const { frames, duration } = timeline;
    const selected = new Set();
    const planned = Array.from({ length: 6 }, (_, slot) => {
        const time = slot === 5 ? Math.max(0, duration - 1) : duration * slot / 5;
        let frame = frames.find(item => item.time + item.delay > time) || frames.at(-1);
        if (frames.length >= 6 && selected.has(frame.index)) {
            frame = frames.filter(item => !selected.has(item.index)).sort((a, b) => Math.abs(a.time - time) - Math.abs(b.time - time))[0];
        }
        selected.add(frame.index);
        return { ...frame, time: frames.length < 6 ? time : frame.time };
    });
    return planned.sort((a, b) => a.time - b.time);
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
    for (let bit = 0; bit < 8; bit++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
    return n >>> 0;
});
function chunk(type, data) {
    const name = Buffer.from(type), block = Buffer.concat([name, data]);
    let crc = 0xffffffff;
    for (const byte of block) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
    const head = Buffer.alloc(4), tail = Buffer.alloc(4);
    head.writeUInt32BE(data.length); tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([head, block, tail]);
}

const digits = {
    '0': ['111','101','101','101','111'], '1': ['010','110','010','010','111'],
    '2': ['111','001','111','100','111'], '3': ['111','001','111','001','111'],
    '4': ['101','101','111','001','001'], '5': ['111','100','111','001','111'],
    '6': ['111','100','111','101','111'], '7': ['111','001','010','010','010'],
    '8': ['111','101','111','101','111'], '9': ['111','101','111','001','111'],
    '.': ['000','000','000','000','010'], 's': ['000','011','100','010','110']
};
async function contactSheet(raw, selected, plan, cell) {
    const gap = 8, caption = 24, width = cell * 2 + gap * 3, height = (cell + caption) * 3 + gap * 4;
    const rgba = Buffer.alloc(width * height * 4, 255), stride = cell * cell * 4;
    for (let slot = 0; slot < 6; slot++) {
        const left = gap + (slot % 2) * (cell + gap), top = gap + Math.floor(slot / 2) * (cell + caption + gap);
        const start = selected.indexOf(plan[slot].index) * stride;
        for (let y = 0; y < cell; y++) for (let x = 0; x < cell; x++) {
            const source = start + (y * cell + x) * 4, target = ((top + y) * width + left + x) * 4;
            const alpha = raw[source + 3] / 255;
            for (let color = 0; color < 3; color++) rgba[target + color] = Math.round(raw[source + color] * alpha + 255 * (1 - alpha));
        }
        const label = `${slot + 1} ${(plan[slot].time / 1000).toFixed(2)}s`;
        const fontScale = cell >= 96 ? 3 : 2;
        for (let letter = 0; letter < label.length; letter++) {
            const shape = digits[label[letter]];
            if (!shape) continue;
            for (let y = 0; y < 5; y++) for (let x = 0; x < 3; x++) if (shape[y][x] === '1') {
                for (let dy = 0; dy < fontScale; dy++) for (let dx = 0; dx < fontScale; dx++) {
                    const target = ((top + cell + 5 + y * fontScale + dy) * width + left + 4 + letter * 4 * fontScale + x * fontScale + dx) * 4;
                    rgba[target] = rgba[target + 1] = rgba[target + 2] = 24;
                }
            }
        }
    }
    const rows = Buffer.alloc((width * 4 + 1) * height);
    for (let y = 0; y < height; y++) rgba.copy(rows, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
    return { png: Buffer.concat([PNG, chunk('IHDR', ihdr), chunk('IDAT', await zip(rows)), chunk('IEND', Buffer.alloc(0))]), width, height };
}

export class GifContactSheet {
    constructor({ directory, ffmpeg = process.env.GUAGUA_FFMPEG_PATH || 'ffmpeg', enabled = true, cell = 320, timeoutMs = 8000,
        now = Date.now, logger = console, decoder } = {}) {
        Object.assign(this, { directory, ffmpeg, enabled, cell, timeoutMs, now, logger });
        this.decoder = decoder || this.decode.bind(this);
        this.cache = new Map(); this.failures = new Map(); this.inflight = new Map();
        this.children = new Set(); this.waiters = []; this.running = 0; this.active = true;
        this.memoryBytes = 0; this.lastPruned = 0;
    }

    fallback(dataUrl) {
        return { dataUrl, animated: true, fallback: true,
            note: '以下GIF未能提取动态序列，已回退原图，接口可能仅展示首帧。只依据可见静态画面、文字和聊天上下文理解，不要声称看过完整动画。' };
    }

    async prepare(dataUrl, { valid = () => true } = {}) {
        const current = () => { try { return valid(); } catch { return false; } };
        if (!current()) return this.fallback(dataUrl);
        const match = /^data:[^,]*;base64,([\s\S]*)$/i.exec(dataUrl || '');
        if (!match || !isGif(Buffer.from(match[1].slice(0, 64), 'base64'))) return { dataUrl, animated: false, fallback: false, note: '' };
        if (!this.enabled) return { ...this.fallback(dataUrl), note: 'GIF动态识别已关闭，本次仅提供原图，接口可能只展示首帧；不能推测未提供的动画过程。' };
        const bytes = Buffer.from(match[1], 'base64');
        if (!this.active || bytes.length > 8 * 1024 * 1024) return this.fallback(dataUrl);
        const key = digest(Buffer.concat([Buffer.from(`${VERSION}:${this.cell}:`), bytes]));
        const cached = this.cache.get(key);
        if (cached && this.now() - cached.at < 7 * DAY) {
            this.cache.delete(key); this.cache.set(key, cached);
            return cached.result;
        }
        if (this.failures.get(key) > this.now()) return this.fallback(dataUrl);
        let entry = this.inflight.get(key);
        const consumer = () => current();
        if (!entry) {
            entry = { consumers: new Set([consumer]) };
            const needed = () => [...entry.consumers].some(check => check());
            entry.task = this.convert(key, bytes, needed).catch(error => {
                if (error.code === 'GIF_CANCELLED' || !this.active || !needed()) return null;
                this.failures.set(key, this.now() + 60000);
                while (this.failures.size > 64) this.failures.delete(this.failures.keys().next().value);
                this.logger.warn?.('[DeepSeek-GIF] 动图处理失败，回退原图：', error.message);
                return null;
            }).finally(() => this.inflight.delete(key));
            this.inflight.set(key, entry);
        } else entry.consumers.add(consumer);
        let result;
        try { result = await entry.task; }
        finally { entry.consumers.delete(consumer); }
        if (!current()) return this.fallback(dataUrl);
        return result?.singleFrame ? { dataUrl, animated: false, fallback: false, note: '' } : result || this.fallback(dataUrl);
    }

    async convert(key, bytes, needed = () => true) {
        const check = () => { if (!this.active || !needed()) throw Object.assign(Error('动图处理已取消'), { code: 'GIF_CANCELLED' }); };
        check();
        const timeline = readGifTimeline(bytes);
        if (timeline.frames.length === 1) return { singleFrame: true };
        const disk = await this.load(key);
        check();
        if (disk) { this.remember(key, disk.result, disk.at); return disk.result; }
        const plan = samples(timeline), selected = [...new Set(plan.map(frame => frame.index))];
        await this.acquire();
        let raw;
        try {
            if (!this.active) throw Error('动图处理已取消');
            check();
            raw = await this.decoder(bytes, selected, this.cell);
        } finally { this.release(); }
        if (!this.active) throw Error('动图处理已取消');
        check();
        if (raw.length !== selected.length * this.cell * this.cell * 4) throw Error('动图解码未返回完整帧');
        const { png, width, height } = await contactSheet(raw, selected, plan, this.cell);
        check();
        const result = { dataUrl: `data:image/png;base64,${png.toString('base64')}`, animated: true, fallback: false,
            note: `以下一张图片是同一个GIF表情的6个采样帧，按2列×3行、从左到右再从上到下排列，编号和时间已标出；原动画一遍约${(timeline.duration / 1000).toFixed(2)}秒。结合动作变化、画面文字和当前对话理解语气，不要当作6张无关图片，也不要编造采样外的动作。` };
        if (this.active) {
            check();
            await this.save(key, png, { note: result.note, width, height }, needed);
            check();
            this.remember(key, result);
        }
        return result;
    }

    async acquire() {
        if (!this.active) throw Error('动图处理已取消');
        if (this.running < 2 && !this.waiters.length) { this.running++; return; }
        const granted = await new Promise(resolve => this.waiters.push(resolve));
        if (!granted) throw Error('动图处理已取消');
        // 许可已由上一任务移交，唤醒期间不能再次递增或让新任务抢占。
        if (!this.active) { this.release(); throw Error('动图处理已取消'); }
    }

    release() {
        if (this.active && this.waiters.length) this.waiters.shift()(true);
        else this.running--;
    }

    remember(key, result, at = this.now()) {
        const previous = this.cache.get(key);
        if (previous) this.memoryBytes -= previous.size;
        const entry = { at, size: Buffer.byteLength(result.dataUrl), result };
        this.cache.delete(key); this.cache.set(key, entry); this.memoryBytes += entry.size;
        while (this.cache.size > 32 || this.memoryBytes > 16 * 1024 * 1024) {
            const oldest = this.cache.keys().next().value;
            this.memoryBytes -= this.cache.get(oldest).size; this.cache.delete(oldest);
        }
    }

    async load(key) {
        if (!this.directory) return null;
        try {
            const metadata = JSON.parse(await fs.readFile(path.join(this.directory, `${key}.json`), 'utf8'));
            if (metadata.version !== VERSION || !Number.isFinite(metadata.at) || this.now() - metadata.at >= 7 * DAY) return null;
            const png = await fs.readFile(path.join(this.directory, `${key}.png`));
            if (!png.subarray(0, 8).equals(PNG) || digest(png) !== metadata.sha256 || typeof metadata.note !== 'string') return null;
            return { at: metadata.at, result: { dataUrl: `data:image/png;base64,${png.toString('base64')}`, animated: true, fallback: false, note: metadata.note } };
        } catch { return null; }
    }

    async save(key, png, metadata, needed = () => true) {
        if (!this.directory || !this.active || !needed()) return;
        const suffix = `.${process.pid}.${randomUUID()}.tmp`, names = [`${key}.png`, `${key}.json`];
        try {
            await fs.mkdir(this.directory, { recursive: true });
            if (!needed()) return;
            const data = [png, JSON.stringify({ ...metadata, version: VERSION, at: this.now(), sha256: digest(png) })];
            for (let i = 0; i < names.length && this.active && needed(); i++) {
                const target = path.join(this.directory, names[i]);
                await fs.writeFile(target + suffix, data[i]);
                if (this.active && needed()) await fs.rename(target + suffix, target);
            }
            if (needed()) await this.prune();
        } catch (error) { if (this.active && needed()) this.logger.warn?.('[DeepSeek-GIF] 拼图缓存未保存：', error.message); }
        finally { await Promise.all(names.map(name => fs.rm(path.join(this.directory, name + suffix), { force: true }).catch(() => {}))); }
    }

    async prune() {
        if (!this.active || this.now() - this.lastPruned < 60000) return;
        this.lastPruned = this.now();
        const entries = [];
        for (const name of await fs.readdir(this.directory)) if (/^[a-f0-9]{64}\.png$/.test(name)) {
            const stat = await fs.stat(path.join(this.directory, name));
            entries.push({ name, at: stat.mtimeMs, size: stat.size });
        }
        entries.sort((a, b) => b.at - a.at);
        let total = 0;
        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i]; total += entry.size;
            if (this.active && (i >= 128 || total > 64 * 1024 * 1024 || this.now() - entry.at >= 7 * DAY)) {
                await fs.rm(path.join(this.directory, entry.name), { force: true });
                await fs.rm(path.join(this.directory, entry.name.replace(/\.png$/, '.json')), { force: true });
            }
        }
    }

    decode(bytes, selected, cell) {
        return new Promise((resolve, reject) => {
            const selection = selected.map(index => `eq(n\\,${index})`).join('+');
            const child = spawn(this.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-ignore_loop', '1', '-i', 'pipe:0',
                '-an', '-sn', '-dn', '-vf', `select=${selection},scale=${cell}:${cell}:force_original_aspect_ratio=decrease,pad=${cell}:${cell}:(ow-iw)/2:(oh-ih)/2:color=white,format=rgba`,
                '-threads', '1', '-vsync', '0', '-frames:v', String(selected.length), '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'],
            { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
            this.children.add(child);
            const output = []; let length = 0, stderr = '', failure;
            const timer = setTimeout(() => { failure = Error('动图解码超时'); child.kill(); }, this.timeoutMs);
            timer.unref?.();
            child.stdout.on('data', chunk => {
                length += chunk.length;
                if (length > selected.length * cell * cell * 4) { failure = Error('动图解码输出超出预期'); child.kill(); }
                else output.push(chunk);
            });
            child.stderr.on('data', chunk => { if (stderr.length < 1000) stderr += chunk.toString(); });
            child.stdin.on('error', () => {});
            child.once('error', error => { clearTimeout(timer); this.children.delete(child); reject(error); });
            child.once('close', code => {
                clearTimeout(timer); this.children.delete(child);
                if (failure || code !== 0) reject(failure || Error(`FFmpeg未能解码GIF（${code}）${stderr ? '，已回退' : ''}`));
                else resolve(Buffer.concat(output));
            });
            child.stdin.end(bytes);
        });
    }

    dispose() {
        this.active = false;
        for (const child of this.children) child.kill();
        for (const resolve of this.waiters.splice(0)) resolve(false);
        this.cache.clear(); this.memoryBytes = 0;
    }
}
