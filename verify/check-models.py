#!/usr/bin/env python3
"""Parses an OpenAI response on STDIN. Mode: `models`, `probe`, or `generation`."""
import json
import sys

WANT = ['gpt-image-2.5-sunburst', 'gpt-image-2.5-flare', 'gpt-image-2',
        'gpt-image-1.5', 'gpt-image-1', 'gpt-image-1-mini']


def fail(msg):
    print('  ✗ ' + msg)
    sys.exit(1)


def parse(raw):
    if not raw.strip():
        fail('empty response — the request probably never arrived (network or firewall)')
    try:
        return json.loads(raw)
    except ValueError as e:
        fail('response is not JSON (%s): %s' % (e, raw[:200]))


def probe():
    """Does the model exist for this key — we ask the generation endpoint itself.

    WHY NOT /v1/models. That endpoint is a catalog, not an access right: it
    shows what OpenAI decided to show there, and new image models arrive late.
    Judging availability from it means confidently hiding a model the user
    can actually work with.

    The request is invalid on purpose (size=1x1), so it generates nothing and
    costs nothing. We read not the result but WHAT exactly it failed on:
      • model_not_found / 404  → the key does not have the model;
      • a complaint about size  → the model was accepted, the request reached the parameters.
    Both conclusions are worth exactly as much as the control lines next to them:
    if a model that certainly does not exist answers the same as a real one, the
    probe tells nothing apart, and the script must say so instead of guessing.
    """
    raw = sys.stdin.read().rsplit('\n', 1)
    body = parse(raw[0])
    code = (raw[1] if len(raw) > 1 else '').strip()
    err = body.get('error') or {}
    ecode = err.get('code') or err.get('type') or ''
    msg = err.get('message') or ''

    if code == '401' or ecode == 'invalid_api_key':
        print('✗ key was not accepted (401) — nothing further to check')
        sys.exit(1)
    if code == '404' or ecode == 'model_not_found' or 'does not exist' in msg:
        print('NO ACCESS — %s' % (msg or ecode or code))
        return
    # Do not search for the word "size" in the text: OpenAI writes "Invalid value: '1x1'…",
    # and the field name lives in err.param. The first version of this check
    # therefore filed a real size refusal under "?? unclear".
    if err.get('param') == 'size' or 'size' in msg.lower():
        print('AVAILABLE — the model was accepted, it failed on the size (that is what we checked)')
        return
    # To complain about any OTHER parameter, the API had to parse the model
    # first. So a 400 that is not about the model is also proof of access, only weaker.
    if code == '400' and 'model' not in msg.lower():
        print('AVAILABLE (probably) — the refusal is not about the model, but about "%s": %s'
              % (err.get('param') or ecode, msg[:80]))
        return
    if not err:
        print('?? response without an error (HTTP %s) — the probe did not work as intended' % code)
        return
    print('?? HTTP %s / %s — %s' % (code, ecode, msg[:120]))


def models():
    body = parse(sys.stdin.read())
    if isinstance(body, dict) and body.get('error'):
        err = body['error']
        fail('API refused: %s — %s' % (err.get('code') or err.get('type'), err.get('message')))
    data = body.get('data')
    if not isinstance(data, list):
        fail('unexpected response shape')
    ids = sorted(m.get('id', '') for m in data if 'image' in m.get('id', ''))
    for w in WANT:
        print(('  ✓ ' if w in ids else '  — ') + w)
    extra = [i for i in ids if i not in WANT]
    if extra:
        print('\n  in the catalog, but NOT in the plugin: ' + ', '.join(extra))
    if [w for w in WANT if w not in ids]:
        print('\n  "—" means only "not in the catalog". Whether there is access is shown by step 2.')


def generation():
    body = parse(sys.stdin.read())
    if isinstance(body, dict) and body.get('error'):
        err = body['error']
        fail('API refused: %s — %s' % (err.get('code') or err.get('type'), err.get('message')))
    usage = body.get('usage') or {}
    print('  ✓ request accepted; usage: ' + json.dumps(usage))
    b64 = ((body.get('data') or [{}])[0] or {}).get('b64_json') or ''
    print('  bytes in the response: %d' % len(b64))


{'models': models, 'probe': probe, 'generation': generation}[
    sys.argv[1] if len(sys.argv) > 1 else 'models']()
