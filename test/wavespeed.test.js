/* WaveSpeed provider: mocked fetch, no paid calls. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ws = require('../providers/wavespeed.js');
const providers = require('../providers/index.js');
const geometry = require('../geometry.js');
const usage = require('../usage.js');
const png = require('../png.js');

const KEY = 'super-secret-wavespeed-key';
const ROOT = path.join(__dirname, '..');

function pngBox(w, h) {
    const bytes = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
    bytes.writeUInt32BE(w, 16);
    bytes.writeUInt32BE(h, 20);
    return new Blob([bytes], { type: 'image/png' });
}

function response(status, body, headers = {}) {
    const lower = {};
    for (const [name, value] of Object.entries(headers)) lower[name.toLowerCase()] = value;
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: name => lower[String(name).toLowerCase()] ?? null },
        text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    };
}

function planFor(modelId, quality = 'high') {
    return geometry.planRequest(ws.capsFor(modelId), { w: 800, h: 600 }, quality);
}

function clocked() {
    let clock = 0;
    const gaps = [];
    return {
        gaps,
        now: () => clock,
        sleep: async ms => { gaps.push(ms); clock += ms; },
    };
}

const pngBytes = png.encodePng(new Uint8Array(3), 1, 1, 3);
const pngB64 = Buffer.from(pngBytes).toString('base64');
const seg = (marker, body) => Uint8Array.from([0xFF, marker, (body.length + 2) >> 8, (body.length + 2) & 0xFF, ...body]);
const jpegBytes = Uint8Array.from([
    ...[0xFF, 0xD8],
    ...seg(0xC0, [8, 0, 8, 0, 8, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]),
    ...[0xFF, 0xD9],
]);
const jpegB64 = Buffer.from(jpegBytes).toString('base64');

test('the registry defaults to WaveSpeed and keeps the other providers', async () => {
    assert.equal(providers.first().id, 'wavespeed');
    assert.deepEqual(providers.list().map(p => p.id), ['wavespeed', 'openai', 'google']);
    const list = await ws.models();
    assert.deepEqual(list.map(m => m.label), [
        'Nano Banana 2 Edit',
        'Nano Banana Pro Edit',
        'Seedream 5.5 Edit',
        'Qwen Image 2.0 Edit',
    ]);
    assert.equal(ws.supportsMask, false);
    assert.equal(ws.supportsRefine, false);
    assert.equal(ws.supportsStream, false);
    assert.equal(ws.capsFor('bytedance/seedream-v5.5/edit').transparent, true);
    assert.equal(ws.capsFor('google/nano-banana-2/edit').transparent, false);
    assert.deepEqual(ws.capsFor('bytedance/seedream-v5.5/edit').imageSizes, ['1K', '2K']);
    assert.equal(usage.forecastCost({
        provider: 'wavespeed', model: list[0].id, quality: 'high', plan: {},
    }).usd, null);
    const entry = usage.createEntry({ provider: 'wavespeed', model: list[0].id }, null);
    assert.equal(entry.costUsd, null);
    const src = fs.readFileSync(path.join(ROOT, 'providers', 'wavespeed.js'), 'utf8');
    assert.doesNotMatch(src, /curl-transport|require\('\.\/http/);
});

function baseArgs(model, extra = {}) {
    const time = clocked();
    return {
        apiKey: KEY,
        model,
        prompt: 'repaint the wall',
        imageBlob: pngBox(512, 512),
        plan: planFor(model),
        fetchImpl: extra.fetchImpl,
        sleep: time.sleep,
        now: time.now,
        time,
        ...extra,
    };
}

test('each model sends only its own fields and enforces image limits', async () => {
    const seen = [];
    const fetchImpl = async (url, init) => {
        seen.push({ url: String(url), init });
        if (String(url).endsWith('/binary')) {
            return response(200, { data: { download_url: `https://cdn.example/up-${seen.length}` } });
        }
        if (!String(url).includes('/result')) {
            const body = JSON.parse(init.body);
            return response(200, { data: { id: 'task-1', status: 'created', body } });
        }
        const posted = seen.find(call => String(call.init && call.init.body || '').startsWith('{'));
        return response(200, { data: { status: 'completed', outputs: [pngB64], posted: JSON.parse(posted.init.body) } });
    };

    for (const id of (await ws.models()).map(m => m.id)) {
        seen.length = 0;
        const res = await ws.generate(baseArgs(id, { fetchImpl }));
        assert.deepEqual(res.usage, null);
        assert.equal(res.images.length, 1);
        const submit = seen.find(call => call.init && call.init.method === 'POST' && !call.url.endsWith('/binary'));
        const body = JSON.parse(submit.init.body);
        assert.equal(body.enable_base64_output, true);
        assert.equal(body.enable_sync_mode, false);
        assert.equal(body.output_format, 'png');
        assert.equal(Object.hasOwn(body, 'resolution') || Object.hasOwn(body, 'aspect_ratio'), id !== 'wavespeed-ai/qwen-image-2.0/edit');
        if (id === 'wavespeed-ai/qwen-image-2.0/edit') {
            assert.match(body.size, /^\d+\*\d+$/);
            assert.equal(body.aspect_ratio, undefined);
            assert.equal(body.resolution, undefined);
        } else {
            assert.equal(body.size, undefined);
            assert.match(body.resolution, /^(1k|2k|4k)$/);
            if (id === 'bytedance/seedream-v5.5/edit') assert.notEqual(body.resolution, '4k');
        }
        assert.equal(body.background, undefined);
        png.prepareForPlace(Buffer.from(res.images[0], 'base64'), 300);
    }

    seen.length = 0;
    const seed = await ws.generate(baseArgs('bytedance/seedream-v5.5/edit', {
        fetchImpl,
        background: 'transparent',
    }));
    assert.equal(seed.images[0], pngB64);
    const seedBody = JSON.parse(seen.find(call => call.init && call.init.method === 'POST' && !call.url.endsWith('/binary')).init.body);
    assert.equal(seedBody.background, 'transparent');

    const jpeg = await ws.generate(baseArgs('google/nano-banana-pro/edit', {
        fetchImpl: async (url, init) => {
            if (String(url).endsWith('/binary')) return response(200, { data: { download_url: 'https://cdn.example/a' } });
            if (!String(url).includes('/result')) return response(200, { data: { id: 'j1', status: 'created' } });
            return response(200, { data: { status: 'completed', outputs: [jpegB64] } });
        },
    }));
    assert.equal(png.prepareForPlace(Buffer.from(jpeg.images[0], 'base64'), 72).ext, 'jpg');

    await assert.rejects(
        () => ws.generate(baseArgs('google/nano-banana-2/edit', {
            references: Array.from({ length: 14 }, () => pngBox(512, 512)),
            fetchImpl: () => { throw new Error('should not upload'); },
        })),
        /at most 14/,
    );
    await assert.rejects(
        () => ws.generate(baseArgs('wavespeed-ai/qwen-image-2.0/edit', {
            prompt: 'x'.repeat(801),
            fetchImpl: () => { throw new Error('should not upload'); },
        })),
        /800/,
    );
});

test('upload order is the captured image then references, and a bad upload never submits', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
        calls.push({ url: String(url), init });
        assert.equal(new URL(url).origin, ws.ORIGIN);
        assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
        assert.equal(JSON.stringify(init.headers).includes('/Users/'), false);
        if (calls.length === 1) {
            assert.equal(init.headers.file, 'image.png');
            assert.equal(init.headers['Content-Type'], 'image/png');
            assert.equal(init.body.byteLength, 24);
            return response(200, { data: { download_url: 'https://cdn.example/first' } });
        }
        if (calls.length === 2) {
            assert.equal(init.body.byteLength, 40);
            return response(200, { data: { download_url: 'https://cdn.example/second' } });
        }
        if (!String(url).includes('/result')) {
            const body = JSON.parse(init.body);
            assert.deepEqual(body.images, ['https://cdn.example/first', 'https://cdn.example/second']);
            return response(200, { data: { id: 'up-1', status: 'queued' } });
        }
        return response(200, { data: { status: 'failed', error: 'stop' } });
    };
    const ref = new Blob([Buffer.alloc(40)], { type: 'image/png' });
    ref.name = '/Users/secret/photo.png';
    const time = clocked();
    const pending = ws.generate({
        apiKey: `  ${KEY}  `,
        model: 'google/nano-banana-2/edit',
        prompt: 'add a window',
        imageBlob: pngBox(400, 400),
        references: [ref],
        plan: planFor('google/nano-banana-2/edit'),
        fetchImpl,
        sleep: time.sleep,
        now: () => 0,
    });
    await assert.rejects(pending);
    const submits = calls.filter(call => call.init.method === 'POST' && !call.url.endsWith('/binary'));
    assert.equal(submits.length, 1);

    for (const broken of [
        async () => response(500, { message: KEY }),
        async () => response(200, { data: { filename: 'image.png' } }),
    ]) {
        let posted = 0;
        await assert.rejects(() => ws.generate(baseArgs('google/nano-banana-2/edit', {
            fetchImpl: async (url, init) => {
                if (String(url).includes('/edit')) posted += 1;
                return broken();
            },
        })), /upload failed/i);
        assert.equal(posted, 0);
    }
});

test('submit runs once, polling stops on each terminal status, and timing stays bounded', async () => {
    const logs = [];
    const real = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    try {
        const calls = [];
        let phase = 'processing';
        const fetchImpl = async (url, init) => {
            calls.push(String(url));
            assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
            if (String(url).endsWith('/binary')) return response(200, { data: { download_url: 'https://cdn.example/a' } });
            if (!String(url).includes('/result')) return response(200, { data: { id: 'pred/1', status: 'queued' } });
            if (phase === 'processing') {
                phase = 'done';
                return response(200, { data: { id: 'pred/1', status: 'processing', outputs: [] } });
            }
            return response(200, { data: { status: 'completed', outputs: [pngB64] } });
        };
        const time = clocked();
        const res = await ws.generate(baseArgs('google/nano-banana-2/edit', { fetchImpl, sleep: time.sleep, now: time.now }));
        assert.deepEqual(res, { images: [pngB64], usage: null });
        assert.equal(calls.filter(url => url.endsWith('/edit')).length, 1);
        assert.ok(calls.some(url => url.includes('/predictions/pred%2F1/result')));
        assert.ok(time.gaps.every(gap => gap >= 2000));
        assert.equal(logs.some(line => line.includes(KEY)), false);

        for (const status of ['failed', 'cancelled', 'timeout', 'deleted']) {
            let reads = 0;
            await assert.rejects(() => ws.generate(baseArgs('google/nano-banana-pro/edit', {
                fetchImpl: async url => {
                    if (String(url).endsWith('/binary')) return response(200, { data: { download_url: 'https://cdn.example/a' } });
                    if (!String(url).includes('/result')) return response(200, { data: { id: 't', status: 'created' } });
                    reads += 1;
                    return response(200, { data: { status, error: KEY } });
                },
            })), new RegExp(status));
            assert.equal(reads, 1);
        }
    } finally {
        console.log = real;
    }
});

test('an ambiguous submit is not repeated, and polling honors backoff, abort and the deadline', async () => {
    let submits = 0;
    await assert.rejects(() => ws.generate(baseArgs('google/nano-banana-2/edit', {
        fetchImpl: async url => {
            if (String(url).endsWith('/binary')) return response(200, { data: { download_url: 'https://cdn.example/a' } });
            submits += 1;
            const err = new Error('socket hang up');
            err.name = 'AbortError';
            throw err;
        },
    })), /WaveSpeed History/);
    assert.equal(submits, 1);

    submits = 0;
    const gaps = [];
    await ws.generate(baseArgs('google/nano-banana-2/edit', {
        sleep: async ms => { gaps.push(ms); },
        now: () => 0,
        fetchImpl: async url => {
            if (String(url).endsWith('/binary')) return response(200, { data: { download_url: 'https://cdn.example/a' } });
            if (!String(url).includes('/result')) {
                submits += 1;
                return response(200, { data: { id: 'slow', status: 'queued' } });
            }
            if (gaps.length === 0) return response(429, { message: 'slow' }, { 'retry-after': '5' });
            return response(200, { data: { status: 'completed', outputs: [pngB64] } });
        },
    }));
    assert.equal(submits, 1);
    assert.ok(gaps[0] >= 5000);

    const ac = new AbortController();
    let polls = 0;
    await assert.rejects(() => ws.generate(baseArgs('google/nano-banana-2/edit', {
        signal: ac.signal,
        sleep: (ms, signal) => {
            if (signal && signal.aborted) {
                const err = new Error('cancelled');
                err.cancelled = true;
                return Promise.reject(err);
            }
            return Promise.resolve();
        },
        now: () => 0,
        fetchImpl: async url => {
            if (String(url).endsWith('/binary')) return response(200, { data: { download_url: 'https://cdn.example/a' } });
            if (!String(url).includes('/result')) return response(200, { data: { id: 'c', status: 'queued' } });
            polls += 1;
            ac.abort();
            return response(200, { data: { status: 'processing' } });
        },
    })), err => err && err.cancelled);
    assert.equal(polls, 1);

    const pending = ws._wait(60_000, AbortSignal.abort());
    await assert.rejects(pending, err => err && err.cancelled);

    let clock = 0;
    let reads = 0;
    await assert.rejects(() => ws.generate(baseArgs('google/nano-banana-2/edit', {
        now: () => clock,
        sleep: async ms => { clock += ms; },
        fetchImpl: async url => {
            if (String(url).endsWith('/binary')) return response(200, { data: { download_url: 'https://cdn.example/a' } });
            if (!String(url).includes('/result')) return response(200, { data: { id: 'd', status: 'queued' } });
            reads += 1;
            return response(200, { data: { status: 'processing' } });
        },
    })), /10 minutes/);
    assert.ok(reads < 400);
    assert.ok(reads > 10);
});

test('bad keys, unknown models and unusable outputs fail before any extra fetch', async () => {
    const forbidden = () => { throw new Error('network'); };
    await assert.rejects(() => ws.generate({
        apiKey: KEY, model: 'nope', prompt: 'x', imageBlob: pngBox(512, 512),
        plan: { aspectRatio: '1:1', imageSize: '1K' }, fetchImpl: forbidden, sleep: async () => {}, now: () => 0,
    }), /not available/);
    await assert.rejects(() => ws.generate(baseArgs('google/nano-banana-2/edit', {
        apiKey: 'bad\nkey', fetchImpl: forbidden,
    })), /invalid/);
    await assert.rejects(() => ws.generate(baseArgs('google/nano-banana-2/edit', {
        imageBlob: null, fetchImpl: forbidden,
    })), /captured image/);
    await assert.rejects(() => ws.generate(baseArgs('google/nano-banana-2/edit', {
        ignorePixels: true, fetchImpl: forbidden,
    })), /cannot ignore/);
    await assert.rejects(() => ws.generate(baseArgs('google/nano-banana-2/edit', {
        background: 'transparent', fetchImpl: forbidden,
    })), /Seedream/);
    const huge = { size: ws.MAX_UPLOAD_BYTES + 1, type: 'image/png', arrayBuffer: async () => { throw new Error('read'); } };
    await assert.rejects(() => ws.generate(baseArgs('google/nano-banana-2/edit', {
        imageBlob: huge, fetchImpl: forbidden,
    })), /100 MB/);
    await assert.rejects(() => ws.generate(baseArgs('wavespeed-ai/qwen-image-2.0/edit', {
        imageBlob: pngBox(100, 512), fetchImpl: forbidden,
    })), /384/);

    let hosts = [];
    await assert.rejects(() => ws.generate(baseArgs('google/nano-banana-2/edit', {
        fetchImpl: async url => {
            hosts.push(new URL(url).host);
            if (String(url).endsWith('/binary')) return response(200, { data: { download_url: 'https://cdn.example/a' } });
            if (!String(url).includes('/result')) return response(400, { message: `nope ${KEY}`, error: KEY });
            return response(200, { data: { status: 'completed', outputs: ['https://cdn.example/out.png'] } });
        },
    })), err => {
        assert.equal(String(err.message).includes(KEY), false);
        assert.match(err.message, /rejected/i);
        return true;
    });
    assert.deepEqual([...new Set(hosts)], ['api.wavespeed.ai']);

    hosts = [];
    await assert.rejects(() => ws.generate(baseArgs('google/nano-banana-2/edit', {
        fetchImpl: async url => {
            hosts.push(String(url));
            if (String(url).endsWith('/binary')) return response(200, { data: { download_url: 'https://cdn.example/a' } });
            if (!String(url).includes('/result')) return response(200, { data: { id: 'u', status: 'queued' } });
            return response(200, { data: { status: 'completed', outputs: ['https://evil.example/secret.png'] } });
        },
    })), /does not download/);
    assert.equal(hosts.some(url => url.includes('evil.example')), false);

    await assert.rejects(() => ws.generate(baseArgs('google/nano-banana-2/edit', {
        fetchImpl: async url => {
            if (String(url).endsWith('/binary')) return response(200, { data: { download_url: 'https://cdn.example/a' } });
            if (!String(url).includes('/result')) return response(200, { data: { id: 'e', status: 'queued' } });
            return response(200, { data: { status: 'completed', outputs: ['AAAA'] } });
        },
    })), /PNG or JPEG/);
    assert.equal(ws.redact(`Bearer ${KEY} says ${KEY}`, KEY).includes(KEY), false);
});

test('requests remain alive across event loop turns and abort while reading a body', async () => {
    await ws.generate(baseArgs('google/nano-banana-2/edit', {
        fetchImpl: async (url, init) => {
            await new Promise(resolve => setTimeout(resolve, 10));
            assert.equal(init.signal.aborted, false);
            assert.equal(init.redirect, 'error');
            if (url.endsWith('/binary')) return response(200, { data: { download_url: 'https://cdn.example/a' } });
            if (!url.includes('/result')) return response(200, { data: { id: 'delayed' } });
            return response(200, { data: { status: 'completed', outputs: [pngB64] } });
        },
    }));
    const controller = new AbortController();
    await assert.rejects(ws.generate(baseArgs('google/nano-banana-2/edit', {
        signal: controller.signal,
        fetchImpl: async () => ({
            ok: true, status: 200,
            text: () => {
                queueMicrotask(() => controller.abort());
                return new Promise(() => {});
            },
        }),
    })), err => err.cancelled === true);
});
