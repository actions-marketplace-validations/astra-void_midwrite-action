#!/usr/bin/env bash
# Runs in inputs.working-directory. On a pull request, analyzes the base
# commit first to record a baseline, then analyzes the head with it, so that
# only findings whose fingerprint is not on the base count as new.
set -uo pipefail

out="$RUNNER_TEMP/midwrite"
mkdir -p "$out"
json="$out/midwrite.json"
sarif="$out/midwrite.sarif"
baseline="$out/baseline.json"

read -r -a paths <<< "${PATHS:-.}"
args=(--policy "$POLICY")
if [[ -n "${CONFIG:-}" ]]; then
  [[ -f "$CONFIG" ]] || { echo "::error::config file $CONFIG not found"; echo "code=2" >> "$GITHUB_OUTPUT"; exit 0; }
  args+=(--config "$(cd "$(dirname "$CONFIG")" && pwd)/$(basename "$CONFIG")")
elif [[ -f midwrite.json ]]; then
  args+=(--config "$PWD/midwrite.json")
fi

base_status="none"
if [[ -n "${BASE_SHA:-}" ]]; then
  base_status="failed"
  root="$(git rev-parse --show-toplevel)"
  tree="$RUNNER_TEMP/midwrite-base"
  rm -rf "$tree"
  if git -C "$root" cat-file -e "$BASE_SHA^{commit}" 2>/dev/null \
     || git -C "$root" fetch --quiet --no-tags --depth=1 origin "$BASE_SHA"; then
    if git -C "$root" worktree add --quiet --detach "$tree" "$BASE_SHA"; then
      # Same relative paths as the head, so fingerprints line up.
      (cd "$tree/${WORKDIR:-.}" && "$MIDWRITE_BIN" check "${paths[@]}" "${args[@]}" --write-baseline "$baseline" > "$out/base.txt" 2>&1)
      base_code=$?
      if [[ -f "$baseline" ]]; then
        base_status="ok"
        [[ $base_code -eq 0 ]] || base_status="partial"
      fi
      git -C "$root" worktree remove --force "$tree" || true
    fi
  fi
  if [[ "$base_status" != ok ]]; then
    echo "::warning::Midwrite could not fully analyze the base commit ($base_status); see $out/base.txt. New-finding detection may be incomplete."
    [[ -f "$out/base.txt" ]] && cat "$out/base.txt"
  fi
fi

if [[ -f "$baseline" ]]; then
  args+=(--baseline "$baseline")
fi

"$MIDWRITE_BIN" check "${paths[@]}" "${args[@]}" --fail-on "$FAIL_ON" --format json > "$json"
code=$?
"$MIDWRITE_BIN" check "${paths[@]}" "${args[@]}" --fail-on never --format sarif > "$sarif" || true
# Human-readable output in the log.
"$MIDWRITE_BIN" check "${paths[@]}" "${args[@]}" --fail-on never || true

new=0
if [[ -s "$json" ]]; then
  new=$(node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const hasBaseline = r.summary && r.summary.baseline;
    console.log(r.diagnostics.filter((d) => !hasBaseline || d.baseline === "new").length);
  ' "$json")
else
  json=""
fi
[[ -s "$sarif" ]] || sarif=""

{
  echo "code=$code"
  echo "new=$new"
  echo "json=$json"
  echo "sarif=$sarif"
  echo "base=$base_status"
} >> "$GITHUB_OUTPUT"
exit 0
