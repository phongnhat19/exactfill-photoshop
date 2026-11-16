#!/usr/bin/env bash
# Does gpt-image-2.5 exist on the live API, and does it accept our request shape?
#
# The key comes from the environment and is written NOWHERE. Run:
#   OPENAI_API_KEY='sk-...' ./verify/check-models.sh
#   OPENAI_API_KEY='sk-...' ./verify/check-models.sh --paid   # + one paid request
#
# Without --paid the script spends nothing: both the catalog and the availability probe are free.
set -uo pipefail

: "${OPENAI_API_KEY:?set OPENAI_API_KEY in the environment}"
CFG="$(mktemp)"; trap 'rm -f "$CFG"' EXIT
printf 'header = "Authorization: Bearer %s"\nsilent\nshow-error\n' "$OPENAI_API_KEY" > "$CFG"
HERE="$(dirname "$0")"

echo "=== 1. What the key sees in the /v1/models catalog ==="
curl --config "$CFG" https://api.openai.com/v1/models \
  | python3 "$HERE/check-models.py" models || exit 1

# The catalog is not an access right. Step 1 shows only what OpenAI chose
# to list; judging model availability from it is the mistake that cost us
# a wrong conclusion on 2026-09-09. So we ask the same endpoint the plugin uses.
echo
echo "=== 2. Does the generation endpoint accept the model itself (free) ==="
echo "    The request is invalid on purpose, so it generates nothing. We read the refusal."
echo
echo "    controls — without them the answers below are worthless:"
for M in gpt-image-2 zzz-model-that-cannot-exist; do
    printf '      %-30s ' "$M"
    curl --config "$CFG" -H 'Content-Type: application/json' -w '\n%{http_code}' \
        -d "{\"model\":\"$M\",\"prompt\":\"x\",\"size\":\"1x1\"}" \
        https://api.openai.com/v1/images/generations \
        | python3 "$HERE/check-models.py" probe || exit 1
done
echo
echo "    what this is all for:"
for M in gpt-image-2.5-sunburst gpt-image-2.5-flare; do
    printf '      %-30s ' "$M"
    curl --config "$CFG" -H 'Content-Type: application/json' -w '\n%{http_code}' \
        -d "{\"model\":\"$M\",\"prompt\":\"x\",\"size\":\"1x1\"}" \
        https://api.openai.com/v1/images/generations \
        | python3 "$HERE/check-models.py" probe || exit 1
done

echo
echo "  How to read it: if the gpt-image-2 control = AVAILABLE and the nonexistent model ="
echo "  NO ACCESS — the probe can tell them apart, and the lines below can be trusted. If both"
echo "  controls are the same — the probe is blind, and we draw no conclusion."

[ "${1:-}" = "--paid" ] || { echo; echo "For a paid check of the request shape: --paid"; exit 0; }

echo
echo "=== 3. Does sunburst accept quality=max and an arbitrary size (PAID, ~1 request) ==="
curl --config "$CFG" -H 'Content-Type: application/json' \
  -d '{"model":"gpt-image-2.5-sunburst","prompt":"a plain grey square","size":"1024x1024","quality":"max","n":1}' \
  https://api.openai.com/v1/images/generations \
  | python3 "$HERE/check-models.py" generation
