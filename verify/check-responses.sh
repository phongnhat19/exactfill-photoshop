#!/usr/bin/env bash
# What the image_generation tool on /v1/responses can actually do.
#
# The key comes from the environment and is written NOWHERE. Run:
#   OPENAI_API_KEY='sk-...' ./verify/check-responses.sh
#
# The script spends nothing: EVERY request is invalid on purpose and is rejected
# by the validator before generation. The value is not in success but in the refusal
# text: the server lists the allowed values of the field we asked nonsense about.
set -uo pipefail

: "${OPENAI_API_KEY:?set OPENAI_API_KEY in the environment}"
CFG="$(mktemp)"; trap 'rm -f "$CFG"' EXIT
printf 'header = "Authorization: Bearer %s"\nheader = "Content-Type: application/json"\nsilent\nshow-error\n' \
    "$OPENAI_API_KEY" > "$CFG"
URL=https://api.openai.com/v1/responses

# Prints the response code and the error message — the only thing we care about.
ask() {
    local label="$1" body="$2"
    printf '\n--- %s\n' "$label"
    curl --config "$CFG" -w '\n%{http_code}' -d "$body" "$URL" | python3 -c '
import json, sys
raw = sys.stdin.read().rsplit("\n", 1)
code = raw[-1].strip()
try:
    j = json.loads(raw[0])
except Exception:
    print(f"    HTTP {code}: {raw[0][:300]}")
    sys.exit()
err = j.get("error") or {}
msg = err.get("message") or json.dumps(j)[:400]
print(f"    HTTP {code} [{err.get(\"param\") or err.get(\"code\") or \"-\"}]")
for line in msg.split(". "):
    print(f"      {line}")
'
}

echo "=== 1. Which model the /v1/responses endpoint itself accepts ==="
ask "top-level model = gpt-image-2 (our image model)" \
    '{"model":"gpt-image-2","input":"x","tools":[{"type":"image_generation"}]}'

echo
echo "=== 2. Does the tool have its own model field, and what does it accept ==="
ask "tools[0].model = zzz-nonexistent" \
    '{"model":"gpt-5.6","input":"x","tools":[{"type":"image_generation","model":"zzz-nonexistent"}]}'
ask "tools[0].model = gpt-image-2.5-sunburst (what we use)" \
    '{"model":"gpt-5.6","input":"","tools":[{"type":"image_generation","model":"gpt-image-2.5-sunburst"}]}'

echo
echo "=== 3. The tool's quality levels ==="
ask "tools[0].quality = zzz" \
    '{"model":"gpt-5.6","input":"x","tools":[{"type":"image_generation","quality":"zzz"}]}'

echo
echo "=== 4. The tool's sizes ==="
ask "tools[0].size = 1x1" \
    '{"model":"gpt-5.6","input":"x","tools":[{"type":"image_generation","size":"1x1"}]}'

echo
echo "=== 5. Mask: is there a path that avoids the Files API ==="
ask "input_image_mask.image_url = data:… (we want to avoid uploading a file)" \
    '{"model":"gpt-5.6","input":"x","tools":[{"type":"image_generation","input_image_mask":{"image_url":"zzz"}}]}'
ask "input_image_mask.file_id = zzz (the documented form — a control)" \
    '{"model":"gpt-5.6","input":"x","tools":[{"type":"image_generation","input_image_mask":{"file_id":"zzz"}}]}'

echo
echo "=== 6. Multi-turn: a reference to the previous call ==="
ask "input[] contains an image_generation_call with a made-up id" \
    '{"model":"gpt-5.6","input":[{"role":"user","content":[{"type":"input_text","text":"x"}]},{"type":"image_generation_call","id":"ig_zzz"}],"tools":[{"type":"image_generation"}]}'

echo
echo "=== 7. Other tool fields (input_fidelity, background, output_format) ==="
ask "input_fidelity = zzz" \
    '{"model":"gpt-5.6","input":"x","tools":[{"type":"image_generation","input_fidelity":"zzz"}]}'
ask "output_format = zzz" \
    '{"model":"gpt-5.6","input":"x","tools":[{"type":"image_generation","output_format":"zzz"}]}'
ask "background = zzz" \
    '{"model":"gpt-5.6","input":"x","tools":[{"type":"image_generation","background":"zzz"}]}'
