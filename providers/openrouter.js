/* ============================================================================
 *  providers/openrouter.js — vision chat and the readiness decision.
 *
 *  Both calls stay on https://openrouter.ai and use the shared HTTP transport,
 *  so abort, timeout, and curl fallback match the image providers. The key and
 *  the image never go to the console.
 * ========================================================================== */

const { request, withRetry, blobToBase64 } = require('./http.js');
const {
    CHAT_URL, DECISION_URL, buildChatBody, buildDecisionBody,
} = require('../conversation.js');

function assertOpenRouter(url) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.host !== 'openrouter.ai') {
        throw new Error('OpenRouter requests stay on openrouter.ai');
    }
}

async function dataUrl(blob) {
    const mime = (blob && blob.type) || 'image/png';
    const b64 = await blobToBase64(blob);
    return `data:${mime};base64,${b64}`;
}

async function post(url, apiKey, body, signal, requestImpl) {
    assertOpenRouter(url);
    const send = requestImpl || request;
    const run = () => send(url, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal,
        timeoutMs: 120000,
    });
    return requestImpl ? run() : withRetry(run, { signal, tries: 3 });
}

async function imageOf(input) {
    if (input.imageUrl) return input.imageUrl;
    if (input.imageBlob) return dataUrl(input.imageBlob);
    if (input.image && input.image.blob) return dataUrl(input.image.blob);
    return '';
}

async function completeChat(input) {
    const imageUrl = await imageOf(input);
    return post(CHAT_URL, input.apiKey, buildChatBody({
        messages: input.messages,
        imageUrl,
        clarify: input.clarify,
        brief: input.brief,
    }), input.signal, input.requestImpl);
}

async function completeDecision(input) {
    const imageUrl = await imageOf(input);
    return post(DECISION_URL, input.apiKey, buildDecisionBody({
        messages: input.messages,
        brief: input.brief,
        imageUrl,
        stamp: input.stamp || (input.image && input.image.stamp),
        references: input.references,
        withdrawn: input.withdrawn,
    }), input.signal, input.requestImpl);
}

module.exports = { assertOpenRouter, completeChat, completeDecision, dataUrl };
