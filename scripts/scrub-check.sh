#!/usr/bin/env bash
# scrub-check.sh — public-repo gate: reject private hostnames, LAN IPs,
# home paths, and key material from tracked files.
#
# Excluded files:
#   - scrub-check.sh itself (it necessarily contains the patterns it hunts for)
#   - pnpm-lock.yaml (lockfile — binary-equivalent content)
#   - TASK_PHASE_A.md (spec — describes the forbidden patterns as documentation)
#   - DECISIONS.md   (spec — describes the allowed 192.0.2.x range as docs)

set -u

findings=0

# Build file list from git, excluding meta-docs and lockfile.
files=$(git ls-files | grep -v -E 'pnpm-lock\.yaml$|scripts/scrub-check\.sh$|TASK_PHASE_A\.md$|DECISIONS\.md$' || true)

if [ -z "$files" ]; then
  echo "scrub-check: clean (no files)"
  exit 0
fi

# --- 1. Absolute home paths: /home/ or /Users/ ---
while IFS= read -r hit; do
  [ -z "$hit" ] && continue
  echo "scrub-check: HOME_PATH $hit"
  findings=$((findings + 1))
done <<EOF
$(echo "$files" | xargs grep -Pn -E '/home/|/Users/' 2>/dev/null || true)
EOF

# --- 2. Private LAN IPv4: 10.x, 192.168.x, 172.16-31.x ---
while IFS= read -r hit; do
  [ -z "$hit" ] && continue
  echo "scrub-check: LAN_IP $hit"
  findings=$((findings + 1))
done <<EOF
$(echo "$files" | xargs grep -Pn -E '(?<![0-9])10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}' 2>/dev/null || true)
$(echo "$files" | xargs grep -Pn -E '192\.168\.[0-9]{1,3}\.[0-9]{1,3}' 2>/dev/null || true)
$(echo "$files" | xargs grep -Pn -E '(?<![0-9])172\.(1[6-9]|2[0-9]|3[01])\.[0-9]{1,3}\.[0-9]{1,3}' 2>/dev/null || true)
EOF

# --- 3. Any literal IPv4 that is NOT 127.0.0.1 and NOT 192.0.2. ---
while IFS= read -r hit; do
  [ -z "$hit" ] && continue
  echo "scrub-check: FOREIGN_IP $hit"
  findings=$((findings + 1))
done <<EOF
$(echo "$files" | xargs grep -Pn -oE '\b[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\b' 2>/dev/null | \
  grep -v -E ':127\.0\.0\.1$|:192\.0\.2\.' || true)
EOF

# --- 4. Key material: BEGIN ... PRIVATE KEY or AKIA ---
while IFS= read -r hit; do
  [ -z "$hit" ] && continue
  echo "scrub-check: KEY_MATERIAL $hit"
  findings=$((findings + 1))
done <<EOF
$(echo "$files" | xargs grep -Pn -E 'BEGIN [A-Z ]*PRIVATE KEY|AKIA' 2>/dev/null || true)
EOF

# --- 5. Private hostname suffix: .local, .lan, .internal ---
while IFS= read -r hit; do
  [ -z "$hit" ] && continue
  echo "scrub-check: PRIVATE_HOST $hit"
  findings=$((findings + 1))
done <<EOF
$(echo "$files" | xargs grep -Pn -E '\.local\b|\.lan\b|\.internal\b' 2>/dev/null || true)
EOF

# --- Result ---
if [ "$findings" -gt 0 ]; then
  echo "scrub-check: FAIL — $findings finding(s)"
  exit 1
fi

echo "scrub-check: clean"
exit 0
