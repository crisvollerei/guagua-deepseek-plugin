import { spawn } from 'node:child_process';
import { inflateSync } from 'node:zlib';

export function tinyGif(delays = [10, 10, 10, 10, 10, 10]) {
    const blocks = [Buffer.from('GIF89a'), Buffer.from([1, 0, 1, 0, 128, 0, 0, 0, 0, 0, 255, 255, 255])];
    for (const delay of delays) blocks.push(Buffer.from([33, 249, 4, 0, delay & 255, delay >> 8, 0, 0,
        44, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 68, 1, 0]));
    blocks.push(Buffer.from([59]));
    return Buffer.concat(blocks);
}

export function disposalGif() {
    const blocks = [Buffer.from('GIF89a'), Buffer.from([2,0,1,0,128,0,0, 0,0,255, 255,0,0])];
    for (const left of [0, 1]) blocks.push(Buffer.from([33,249,4,8,10,0,0,0,
        44,left,0,0,0,1,0,1,0,0,2,2,76,1,0]));
    blocks.push(Buffer.from([59]));
    return Buffer.concat(blocks);
}

export function rgbaFrames(indices, cell) {
    const frames = [];
    for (const index of indices) {
        const frame = Buffer.alloc(cell * cell * 4);
        const colors = [[240, 10, 10], [10, 240, 10], [10, 10, 240], [240, 240, 10], [10, 240, 240], [240, 10, 240]];
        for (let pixel = 0; pixel < cell * cell; pixel++) {
            const offset = pixel * 4;
            colors[index % colors.length].forEach((value, channel) => { frame[offset + channel] = value; });
            frame[offset + 3] = 255;
        }
        frames.push(frame);
    }
    return Buffer.concat(frames);
}

export function ffmpeg(args, input) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.env.GUAGUA_FFMPEG_PATH || 'ffmpeg', args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        const chunks = []; let stderr = '';
        const timer = setTimeout(() => { child.kill(); reject(Error('fixture FFmpeg timeout')); }, 15000);
        child.stdout.on('data', chunk => chunks.push(chunk));
        child.stderr.on('data', chunk => { stderr += chunk.toString(); });
        child.stdin.on('error', () => {});
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(Buffer.concat(chunks)) : reject(Error(stderr || `FFmpeg ${code}`)); });
        child.stdin.end(input);
    });
}

export function readSheet(dataUrl) {
    const png = Buffer.from(dataUrl.split(',')[1], 'base64'), idat = [];
    const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
    for (let at = 8; at < png.length;) {
        const size = png.readUInt32BE(at), type = png.toString('ascii', at + 4, at + 8);
        if (type === 'IDAT') idat.push(png.subarray(at + 8, at + 8 + size));
        at += size + 12;
    }
    const bytes = inflateSync(Buffer.concat(idat));
    const pixel = (x, y) => [...bytes.subarray(y * (width * 4 + 1) + 1 + x * 4, y * (width * 4 + 1) + 1 + x * 4 + 4)];
    return { width, height, pixel };
}
