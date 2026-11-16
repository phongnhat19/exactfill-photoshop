/* Discussion gate: mocked chat and decision, no paid calls. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const talk = require('../conversation.js');
const openrouter = require('../providers/openrouter.js');

const ROOT = path.join(__dirname, '..');
const STAMP = { docId: 7, layerId: 3, layerOnly: false, pad: 15, left: 1, top: 2, right: 30, bottom: 40 };
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function chatPayload(data) {
    return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(data) } }] };
}

function decisionPayload(choice, extra = {}) {
    return { answers: { readiness: { type: 'choice', choice, ...extra } } };
}

function captured() {
    return { blob: new Blob([PNG], { type: 'image/png' }), stamp: { ...STAMP }, ctx: { w: 10, h: 10 }, target: {} };
}

function harness(overrides = {}) {
    const calls = { chat: 0, decide: 0, generate: 0, prompts: [] };
    const session = talk.createSession();
    const input = {
        text: 'Đổi cửa thành màu đỏ',
        presets: [],
        cancelledText: 'Đã dừng. Chưa sửa ảnh.',
        fallbackQuestion: 'Bạn muốn sửa đúng chi tiết nào?',
        capture: async () => captured(),
        context: async () => ({ ...STAMP }),
        chat: async () => {
            calls.chat += 1;
            return chatPayload({ brief: 'Đổi cửa thành màu đỏ', question: '', withdrawn: false });
        },
        decide: async () => {
            calls.decide += 1;
            return decisionPayload('ready', { probabilities: { ready: 0.4 }, confidence: 0.2 });
        },
        generate: async ({ prompt, stillCurrent }) => {
            assert.equal(stillCurrent(), true);
            calls.generate += 1;
            calls.prompts.push(prompt);
        },
        ...overrides,
    };
    return { session, input, calls };
}

test('a clear ready decision generates exactly once', async () => {
    const { session, input, calls } = harness({
        generate: async ({ prompt, stillCurrent }) => {
            calls.generate += 1;
            calls.prompts.push(prompt);
            assert.equal(stillCurrent(), true);
            assert.equal(session.generatedOp > 0, true);
            assert.equal(session.generatedOp === session.epoch, true);
        },
    });
    const result = await talk.runTurn(session, input);
    assert.equal(result.generated, true);
    assert.equal(calls.generate, 1);
    assert.equal(calls.decide, 1);
    assert.equal(result.prompt, 'Đổi cửa thành màu đỏ');
    const again = await talk.runTurn(session, input);
    assert.equal(again.generated, true);
    assert.equal(calls.generate, 2, 'a later user send is a new request');
});

test('clarify, cancel, reset, and a stale context do not generate', async () => {
    const clarify = harness({
        chat: async () => chatPayload({ brief: 'Sửa biển', question: 'Biển cần ghi chữ gì?', withdrawn: false }),
        decide: async () => decisionPayload('clarify'),
    });
    const clarified = await talk.runTurn(clarify.session, clarify.input);
    assert.equal(clarified.reason, 'clarify');
    assert.equal(clarify.calls.generate, 0);
    assert.equal(clarify.session.messages.at(-1).text, 'Biển cần ghi chữ gì?');

    const cancel = harness({
        decide: async () => {
            cancel.session.epoch += 1;
            return decisionPayload('ready');
        },
    });
    const cancelled = await talk.runTurn(cancel.session, cancel.input);
    assert.equal(cancelled.reason, 'cancelled');
    assert.equal(cancel.calls.generate, 0);

    const reset = harness({
        decide: async () => {
            reset.session.messages = [];
            reset.session.anchor = null;
            reset.session.brief = '';
            reset.session.generatedOp = null;
            reset.session.epoch += 1;
            return decisionPayload('ready');
        },
    });
    assert.equal((await talk.runTurn(reset.session, reset.input)).generated, false);
    assert.equal(reset.calls.generate, 0);

    const stale = harness({
        context: async () => ({ ...STAMP, docId: 99 }),
    });
    const moved = await talk.runTurn(stale.session, stale.input);
    assert.equal(moved.reason, 'context');
    assert.equal(stale.calls.generate, 0);
    assert.equal(stale.session.messages.length, 0);
    assert.equal(stale.session.anchor, null);
});

test('malformed, refused, and failed responses are not ready', async () => {
    for (const chat of [
        async () => ({ choices: [{ finish_reason: 'stop', message: { content: 'not json' } }] }),
        async () => ({ choices: [{ finish_reason: 'refusal', message: { refusal: 'no', content: '' } }] }),
        async () => { throw new Error('HTTP 500'); },
    ]) {
        const run = harness({ chat });
        const result = await talk.runTurn(run.session, run.input);
        assert.equal(result.generated, false);
        assert.equal(run.calls.generate, 0);
    }

    const badDecision = harness({
        decide: async () => ({ decision: { answers: { readiness: { type: 'choice', choice: 'ship-it' } } } }),
    });
    assert.equal((await talk.runTurn(badDecision.session, badDecision.input)).reason, 'malformed');
    assert.equal(badDecision.calls.generate, 0);

    const apiDecision = harness({ decide: async () => { throw new Error('HTTP 401'); } });
    assert.equal((await talk.runTurn(apiDecision.session, apiDecision.input)).reason, 'api');
    assert.equal(apiDecision.calls.generate, 0);

    assert.equal(talk.parseDecision({ decision: { answers: { readiness: { choice: 'ready' } } } }).ok, false);
    assert.equal(talk.parseChat(chatPayload({
        brief: 'x', question: '', withdrawn: false, choice: 'ready',
    })).ok, true);
    assert.equal(talk.parseDecision(decisionPayload('clarify')).choice, 'clarify');
});

test('the brief keeps literal Vietnamese and presets do not replace it', () => {
    const decomposed = 'Thêm chữ Cà phê'.normalize('NFD');
    const parsed = talk.parseChat(chatPayload({ brief: decomposed, question: '', withdrawn: false }));
    assert.equal(parsed.brief, 'Thêm chữ Cà phê'.normalize('NFC'));
    assert.equal(parsed.brief.normalize('NFC'), parsed.brief);
    const prompt = talk.composePrompt(parsed.brief, ['ánh sáng điện ảnh']);
    assert.equal(prompt, 'Thêm chữ Cà phê ánh sáng điện ảnh');
    assert.equal(talk.composePrompt('   ', ['chỉ có preset']), '');
});

test('the documented REST response is parsed and a withdrawn request never generates', async () => {
    assert.equal(talk.parseDecision({
        model: talk.DECISION_MODEL,
        answers: { readiness: { type: 'choice', choice: 'ready', confidence: 0.9 } },
    }).choice, 'ready');
    assert.equal(talk.parseDecision({ decision: decisionPayload('ready') }).ok, false);
    const run = harness({
        text: 'Không sửa nữa',
        chat: async () => chatPayload({ brief: 'Đổi cửa', question: '', withdrawn: true }),
    });
    assert.equal((await talk.runTurn(run.session, run.input)).reason, 'cancelled');
    assert.equal(run.calls.generate, 0);
});

test('long composer messages retain their final constraints in the conversation', async () => {
    const text = 'x'.repeat(4500) + ' Giữ nguyên chữ tiếng Việt';
    const run = harness({ text, decide: async () => decisionPayload('clarify') });
    await talk.runTurn(run.session, run.input);
    assert.equal(run.session.messages[0].text, text);
});

test('HeyGen sees the image, the original conversation, and the brief', () => {
    const messages = [
        { role: 'user', text: 'Đổi áo thành màu xanh' },
        { role: 'assistant', text: 'Xanh nào?' },
        { role: 'user', text: 'Xanh navy' },
    ];
    const body = talk.buildDecisionBody({
        messages,
        brief: 'Đổi áo thành màu xanh navy',
        imageUrl: 'data:image/png;base64,aaaa',
        stamp: STAMP,
        references: [{ name: 'swatch.png' }],
        withdrawn: false,
    });
    assert.equal(body.model, 'heygen/heygen-decision-1-turbo');
    assert.equal(body.questions.readiness.criteria.ready,
        'target/change clear, no material unresolved ambiguity; optional preferences do not block');
    assert.equal(body.state[1].image_url.url, 'data:image/png;base64,aaaa');
    const text = body.state[0];
    assert.match(text, /USER: Đổi áo thành màu xanh/);
    assert.match(text, /ASSISTANT: Xanh nào\?/);
    assert.match(text, /USER: Xanh navy/);
    assert.match(text, /Đổi áo thành màu xanh navy/);
    assert.match(text, /swatch\.png/);
    assert.match(text, /Document 7, layer 3/);
    const chat = talk.buildChatBody({ messages, imageUrl: 'data:image/png;base64,aaaa' });
    assert.equal(chat.model, 'google/gemini-3.8-flash');
    const last = chat.messages.at(-1);
    assert.equal(last.content[1].image_url.url, 'data:image/png;base64,aaaa');
    assert.match(JSON.stringify(chat.response_format), /withdrawn/);
});

test('OpenRouter calls stay on openrouter.ai and do not log the key or the image', async () => {
    const seen = [];
    const logs = [];
    const original = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    try {
        const blob = new Blob([PNG], { type: 'image/png' });
        blob.arrayBuffer = async () => PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength);
        const requestImpl = async (url, init) => {
            seen.push({ url, init });
            if (String(url).includes('/decisions')) return decisionPayload('clarify');
            return chatPayload({ brief: 'Giữ nguyên', question: 'Giữ phần nào?', withdrawn: false });
        };
        await openrouter.completeChat({
            apiKey: 'or-secret-key',
            messages: [{ role: 'user', text: 'Sửa nền' }],
            imageBlob: blob,
            requestImpl,
        });
        await openrouter.completeDecision({
            apiKey: 'or-secret-key',
            messages: [{ role: 'user', text: 'Sửa nền' }],
            brief: 'Sửa nền',
            imageBlob: blob,
            stamp: STAMP,
            requestImpl,
        });
    } finally {
        console.log = original;
    }
    assert.deepEqual(seen.map(call => call.url), [talk.CHAT_URL, talk.DECISION_URL]);
    assert.match(seen[0].init.headers.Authorization, /^Bearer or-secret-key$/);
    const joined = logs.join('\n');
    assert.equal(joined.includes('or-secret-key'), false);
    assert.equal(joined.includes('base64'), false);
    assert.throws(() => openrouter.assertOpenRouter('https://evil.example/api'), /openrouter\.ai/);
});

test('the panel, manifest, and curl allowlist admit OpenRouter and drop the old Generate button', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const manifest = fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8');
    const curl = fs.readFileSync(path.join(ROOT, 'providers', 'curl-transport.js'), 'utf8');
    const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    assert.match(html, /id="talk-log"[^>]*role="log"/);
    assert.match(html, /id="talk-send"/);
    assert.match(html, /id="openrouter-key-input"/);
    assert.doesNotMatch(html, /id="generate-btn"/);
    assert.match(manifest, /https:\/\/openrouter\.ai/);
    assert.match(curl, /openrouter\.ai/);
    assert.match(main, /runTurn\(talkSession/);
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'conversation.js'), 'utf8'), /localStorage/);
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'providers', 'openrouter.js'), 'utf8'), /localStorage/);
});
