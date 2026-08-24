#!/usr/bin/env bash
# verify.sh — gate: typecheck + test + scrub-check + README-quickstart lint.
# Exits non-zero on the first failure.

set -euo pipefail

SCRIPTS=$(jq -r '.scripts // {} | keys[]' package.json 2>/dev/null || true)

fail=0

# --- Step 1: typecheck ---
echo "verify: typecheck ..."
if pnpm typecheck; then
  echo "verify: typecheck — ok"
else
  echo "verify: typecheck — FAIL"
  exit 1
fi

# --- Step 2: test ---
echo "verify: test ..."
if pnpm test; then
  echo "verify: test — ok"
else
  echo "verify: test — FAIL"
  exit 1
fi

# --- Step 3: scrub-check ---
echo "verify: scrub-check ..."
if bash scripts/scrub-check.sh; then
  echo "verify: scrub-check — ok"
else
  echo "verify: scrub-check — FAIL"
  exit 1
fi

# --- Step 4: README-quickstart lint ---
echo "verify: readme-lint ..."

# Extract lines from fenced code blocks in README.md.
# Only consider lines starting with "pnpm " or "bash " (with optional
# DATABASE_URL=... prefix before pnpm).
resolve=0
unresolved=0

while IFS= read -r line; do
  [ -z "$line" ] && continue

  cmd=""
  if [[ "$line" =~ ^pnpm\  ]]; then
    cmd="$line"
  elif [[ "$line" =~ ^bash\  ]]; then
    cmd="$line"
  elif [[ "$line" =~ ^DATABASE_URL=.*pnpm\  ]]; then
    # Strip the DATABASE_URL=... prefix, keep "pnpm ..."
    cmd="${line#*pnpm }"
    cmd="pnpm $cmd"
  else
    continue
  fi

  # Resolve the command
  resolved=""
  if [[ "$cmd" =~ ^pnpm\ ([a-zA-Z0-9_-]+) ]]; then
    subcmd="${BASH_REMATCH[1]}"
    if [ "$subcmd" = "install" ]; then
      resolved="ok (built-in)"
    elif echo "$SCRIPTS" | grep -qx "$subcmd"; then
      resolved="ok (package.json scripts)"
    else
      resolved="FAIL (not in package.json scripts)"
      unresolved=$((unresolved + 1))
    fi
  elif [[ "$cmd" =~ ^bash\ (.+) ]]; then
    scriptpath="${BASH_REMATCH[1]}"
    if [ -f "$scriptpath" ]; then
      resolved="ok (file exists)"
    else
      resolved="FAIL (file not found: $scriptpath)"
      unresolved=$((unresolved + 1))
    fi
  else
    resolved="ok (unmatched pattern)"
  fi

  resolve=$((resolve + 1))
  echo "  $cmd → $resolved"
done <<EOF
$(sed -n '/^```/,/^```/p' README.md | grep -E '^pnpm |^bash |^DATABASE_URL=')
EOF

echo "verify: readme-lint — $resolve command(s) checked, $unresolved unresolved"

if [ "$unresolved" -gt 0 ]; then
  echo "verify: readme-lint — FAIL"
  exit 1
fi

echo "verify: readme-lint — ok"

echo "verify: all checks passed"
exit 0
