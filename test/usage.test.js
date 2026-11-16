const test = require('node:test');
const assert = require('node:assert/strict');

const usage = require('../usage.js');

const closeTo = (actual, expected, epsilon = 1e-9) => {
    assert.ok(Math.abs(actual - expected) < epsilon, `${actual} ≠ ${expected}`);
};

test('OpenAI counts separate text/image input and image output tokens', () => {
    const result = usage.estimateCost({
        provider: 'openai', model: 'gpt-image-1.5', quality: 'medium',
        plan: { size: '1024x1024' }, imageCount: 1, hasImageInput: true,
    }, {
        input_tokens: 3000,
        output_tokens: 1000,
        input_tokens_details: { text_tokens: 1000, image_tokens: 2000 },
    });
    closeTo(result.usd, 0.053);
    assert.equal(result.method, 'tokens');
});

test('an OpenAI fixed-price model uses the official picture price without output usage', () => {
    const result = usage.estimateCost({
        provider: 'openai', model: 'gpt-image-1', quality: 'medium',
        plan: { size: '1024x1536' }, imageCount: 1, hasImageInput: false,
    }, null);
    closeTo(result.usd, 0.063);
    assert.equal(result.method, 'flat');
});

test('GPT Image 2 does not invent a price when the API returned no output usage', () => {
    const result = usage.estimateCost({
        provider: 'openai', model: 'gpt-image-2', quality: 'high',
        plan: { size: '2048x2048' }, imageCount: 1, hasImageInput: true,
    }, { input_tokens: 1000 });
    assert.equal(result.usd, null);
    assert.equal(result.method, 'missing-output-usage');
});

test('Gemini without output detail takes the price of the requested size', () => {
    const result = usage.estimateCost({
        provider: 'google', model: 'models/gemini-3.1-flash-image',
        plan: { imageSize: '2K' }, imageCount: 1,
    }, { input_tokens: 2000, output_tokens: 1800 });
    closeTo(result.usd, 0.102);
    assert.equal(result.method, 'tokens+flat');
});

test('Gemini with modality usage prices image and text output at different rates', () => {
    const result = usage.estimateCost({
        provider: 'google', model: 'gemini-3.1-flash-image',
        plan: { imageSize: '2K' }, imageCount: 1,
    }, {
        input_tokens: 2000,
        thought_tokens: 50,
        output_tokens_details: [
            { modality: 'IMAGE', tokenCount: 1600 },
            { modality: 'TEXT', tokenCount: 100 },
        ],
    });
    closeTo(result.usd, 0.09745);
    assert.equal(result.method, 'modality-tokens');
});

test('the Gemini Pro 4K fallback includes the input and the picture', () => {
    const result = usage.estimateCost({
        provider: 'google', model: 'gemini-3-pro-image',
        plan: { imageSize: '4K' }, imageCount: 1,
    }, { input_tokens: 1000 });
    closeTo(result.usd, 0.242);
});

test('Nano Banana 2.1 4K is $0.113 from the official table, not $0.0756 from third-party reviews', () => {
    const result = usage.estimateCost({
        provider: 'google', model: 'models/gemini-nano-banana-2.1',
        plan: { imageSize: '4K' }, imageCount: 1,
    }, null);
    closeTo(result.usd, 0.113);
    assert.equal(result.method, 'flat');
});

test('the log gives the last request, today, and the last seven calendar days', () => {
    const now = new Date(2026, 7, 11, 12, 0, 0).getTime();
    const entry = (daysAgo, cost) => ({
        at: new Date(now - daysAgo * 24 * 60 * 60 * 1000).toISOString(),
        inputTokens: 100, outputTokens: 200, costUsd: cost,
    });
    const result = usage.summarize([entry(8, 8), entry(2, 2), entry(0, 1)], now);
    assert.equal(result.last.costUsd, 1);
    assert.equal(result.today.requests, 1);
    assert.equal(result.today.usd, 1);
    assert.equal(result.sevenDays.requests, 2);
    assert.equal(result.sevenDays.usd, 3);
    assert.equal(result.all.requests, 3);
});

test('the log is limited to 500 records', () => {
    const now = Date.now();
    const entries = Array.from({ length: 520 }, (_, i) => ({
        at: new Date(now - i * 1000).toISOString(), costUsd: 0.01,
    }));
    assert.equal(usage.prune(entries, now).length, usage.MAX_ENTRIES);
});

test('a small request cost does not lose thousandths of a dollar in the display', () => {
    assert.equal(usage.formatUsd(0.034), '$0.034');
    assert.equal(usage.formatUsd(0.0054), '$0.0054');
});

/* ── Price forecast BEFORE the request ─────────────────────────────────────── */

const entry = (model, quality, inputTokens, outputTokens) =>
    ({ model, quality, inputTokens, outputTokens });

test('the forecast matches the real log median at every measured level', () => {
    /* The numbers on the right are NOT invented expectations, they are costUsd
       medians from 80 real log records for 2026-08-11…2026-09-09. If the
       SEED_TOKENS table ever diverges from reality, this test is what falls. */
    const truth = [
        ['gpt-image-2', 'low', 0.0074],
        ['gpt-image-2', 'medium', 0.0682],
        ['gpt-image-2', 'high', 0.5023],
        ['gpt-image-2.5-sunburst', 'high', 0.1299],
        ['gpt-image-2.5-sunburst', 'max', 0.2172],
    ];
    for (const [model, quality, actual] of truth) {
        const f = usage.forecastCost({ provider: 'openai', model, quality, plan: { size: '2944x1232' } });
        const err = Math.abs(f.usd - actual) / actual;
        assert.ok(err < 0.05, `${model} ${quality}: forecast ${f.usd} against the fact ${actual} (${(err * 100).toFixed(1)}%)`);
        assert.ok(f.low < f.usd && f.usd < f.high, 'the range must surround the median');
    }
});

test('with no observations the forecast stays silent instead of inventing a number', () => {
    const f = usage.forecastCost({ provider: 'openai', model: 'gpt-image-2.5-flare', quality: 'max', plan: {} });
    assert.equal(f.usd, null);
    assert.equal(f.method, 'no-observations');
});

test('the user\'s own log overrides the built-in seed after three requests', () => {
    const few = [entry('gpt-image-2', 'high', 1500, 40000), entry('gpt-image-2', 'high', 1500, 40000)];
    const seeded = usage.forecastCost({ provider: 'openai', model: 'gpt-image-2', quality: 'high', plan: {}, history: few });
    assert.equal(seeded.method, 'seed-median', 'two records are not enough to override the measurement');

    const enough = few.concat([entry('gpt-image-2', 'high', 1500, 40000)]);
    const own = usage.forecastCost({ provider: 'openai', model: 'gpt-image-2', quality: 'high', plan: {}, history: enough });
    assert.equal(own.method, 'own-history');
    assert.equal(own.samples, 3);
    assert.ok(own.usd > seeded.usd * 2, 'a more expensive own history must raise the forecast');
});

test('where there is no seed, one own request is enough, otherwise the forecast would never appear', () => {
    const history = [entry('gpt-image-2.5-flare', 'max', 700, 9000)];
    const f = usage.forecastCost({ provider: 'openai', model: 'gpt-image-2.5-flare', quality: 'max', plan: {}, history });
    assert.equal(f.method, 'own-history');
    assert.equal(f.samples, 1);
    assert.ok(f.usd > 0.26 && f.usd < 0.28, `expected ≈$0.276, got ${f.usd}`);
});

test('a different model in the log does not enter the forecast', () => {
    const history = [entry('gpt-image-2', 'high', 1500, 40000), entry('gpt-image-2', 'high', 1500, 40000),
                     entry('gpt-image-2', 'high', 1500, 40000)];
    const f = usage.forecastCost({ provider: 'openai', model: 'gpt-image-2.5-sunburst', quality: 'high', plan: {}, history });
    assert.equal(f.method, 'seed-median', 'gpt-image-2 records do not describe 2.5');
});

test('a model priced per picture does not need a range', () => {
    const f = usage.forecastCost({ provider: 'openai', model: 'gpt-image-1.5', quality: 'high', plan: { size: '1024x1024' } });
    assert.equal(f.method, 'flat');
    assert.equal(f.low, f.high);
    assert.ok(Math.abs(f.usd - (0.133 + 1500 * 8 / 1e6)) < 0.001);
});
