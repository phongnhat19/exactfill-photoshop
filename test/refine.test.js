/* ============================================================================
 *  The refine route: /v1/responses with the image_generation tool.
 *
 *  A live run is the most expensive way to find a bug in the request body:
 *  a wrong key is paid for by the user, sometimes in money, not by a validator.
 *  So everything that can be checked without the network is checked without it:
 *  what goes into input, when pixels go there and when a conversation id does,
 *  and what happens to a response that contains no picture.
 * ========================================================================== */

const assert = require('node:assert/strict');
const test = require('node:test');

const openai = require('../providers/openai.js');
const usage = require('../usage.js');
const { refineTool, refineInput, extractResponseImage, rejectsToolModel } = openai._refineParts;

test('the first turn carries pixels, the later ones only text', () => {
    const first = refineInput({ prompt: 'softer shadow', previousResponseId: null, previousImage: 'QUJD' });
    assert.equal(first.length, 1);
    const parts = first[0].content;
    assert.equal(parts[0].type, 'input_text');
    assert.equal(parts[1].type, 'input_image');
    assert.match(parts[1].image_url, /^data:image\/png;base64,QUJD$/,
        'pixels must travel as a data-URI, without the Files API');

    /* WHAT MATTERS HERE IS WHAT TURN ≥2 MUST NOT CONTAIN. The documentation
       example sends the image_generation_call itself back by id; with a reasoning
       model that is a 400 (measured on the live API 2026-09-09): a node cannot be
       inserted without its reasoning parent. The server carries the chain via previous_response_id. */
    const next = refineInput({ prompt: 'warmer now', previousResponseId: 'resp_1', previousImage: 'QUJD' });
    assert.equal(next.length, 1, 'no extra input elements — only the reply');
    assert.equal(next[0].content.length, 1, 'once the conversation continues, pixels are not sent again');
    assert.equal(JSON.stringify(next).includes('image_generation_call'), false,
        'feeding the call back by hand is exactly the bug this test exists for');
});

test('the tool carries only what it was given, and nothing extra', () => {
    const full = refineTool({ plan: { size: '1024x1024', quality: 'high' },
                              model: 'gpt-image-2', withModel: true, partials: true });
    assert.deepEqual(full, {
        type: 'image_generation', output_format: 'png', model: 'gpt-image-2',
        size: '1024x1024', quality: 'high', partial_images: 3,
    });

    // quality=auto means "let the server decide" — it must not be sent as a value,
    // or we impose a level the user did not choose.
    const auto = refineTool({ plan: { quality: 'auto' }, model: 'gpt-image-2', withModel: false });
    // The format always stays: on Responses the default is not png, and without
    // pHYs insertion loses the document resolution — see OUTPUT_FORMAT.
    assert.deepEqual(auto, { type: 'image_generation', output_format: 'png' });
});

test('a response without a picture explains itself with the model text instead of staying silent', () => {
    const withImage = extractResponseImage({
        id: 'resp_7',
        output: [{ type: 'message', content: [{ text: 'here' }] },
                 { type: 'image_generation_call', id: 'ig_9', result: 'QUJD' }],
        usage: { input_tokens: 10, output_tokens: 20 },
    });
    assert.deepEqual(withImage.images, ['QUJD']);
    assert.equal(withImage.responseId, 'resp_7', 'without it the next turn would start the conversation over');
    assert.equal(withImage.callId, 'ig_9', 'the call id stays for the log');

    assert.throws(
        () => extractResponseImage({ output: [{ type: 'message', content: [{ text: 'I cannot do this' }] }] }),
        /I cannot do this/);
});

test('an empty call without a result is not treated as a picture', () => {
    assert.throws(() => extractResponseImage({ output: [{ type: 'image_generation_call', id: 'ig_1' }] }),
        /.+/);
});

test('the fallback without model fires only on a complaint about that field', () => {
    assert.ok(rejectsToolModel({ status: 400, message: "Unknown parameter: 'tools[0].model'." }));
    assert.ok(rejectsToolModel({ status: 400, message: 'Unsupported model field in tool' }));
    // What the fallback must NOT do: otherwise a clear "model does not exist"
    // refusal would turn into a second identical request and the same error,
    // but with the cause no longer mentioned.
    assert.equal(rejectsToolModel({ status: 404, message: "The model 'gpt-5.6' does not exist" }), false);
    assert.equal(rejectsToolModel({ status: 400, message: 'Invalid prompt' }), false);
    assert.equal(rejectsToolModel(null), false);
});

test('the route is part of the forecast key, not a detail of the record', () => {
    const at = new Date().toISOString();
    const row = (route, out) => ({ at, model: 'gpt-image-2', quality: 'low', route,
                                   inputTokens: 400, outputTokens: out });
    // Three expensive refinements must not make the forecast of an ordinary generation more expensive.
    const history = [row('responses', 50000), row('responses', 50000), row('responses', 50000),
                     row('edits', 140), row('edits', 141), row('edits', 142)];
    const f = usage.forecastCost({ provider: 'openai', model: 'gpt-image-2',
                                   quality: 'low', plan: {}, history });
    assert.equal(f.method, 'own-history');
    assert.equal(f.samples, 3, 'only edits records must enter the median');
    assert.ok(f.usd < 0.02, `forecast ${f.usd} — responses records leaked into the median`);
});

test('old records without a route field are read as edits', () => {
    const at = new Date().toISOString();
    const old = n => ({ at, model: 'gpt-image-2', quality: 'low', inputTokens: 400, outputTokens: n });
    const f = usage.forecastCost({ provider: 'openai', model: 'gpt-image-2', quality: 'low',
                                   plan: {}, history: [old(140), old(141), old(142)] });
    assert.equal(f.samples, 3, 'the log before 2026-09-09 has no route — and must not disappear from the forecast');
});

test('createEntry sets the route', () => {
    assert.equal(usage.createEntry({ provider: 'openai', model: 'gpt-image-2' }, null).route, 'edits');
    assert.equal(usage.createEntry({ provider: 'openai', model: 'gpt-image-2', route: 'responses' }, null).route,
        'responses');
});

test('the provider declares that it can converse, and that is not a prop', () => {
    assert.equal(openai.supportsRefine, true);
    assert.equal(typeof openai.refine, 'function');
    const google = require('../providers/google.js');
    assert.notEqual(google.supportsRefine, true, 'Gemini has no such route — the button must be grey');
});

test('a refine with no source refuses before the network', async () => {
    await assert.rejects(
        () => openai.refine({ apiKey: 'sk-x', model: 'gpt-image-2', prompt: 'x',
                              previousResponseId: null, previousImage: null, plan: {} }),
        /.+/);
});
