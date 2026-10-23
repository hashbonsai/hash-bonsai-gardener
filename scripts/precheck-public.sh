#!/bin/sh
# Run before every `git push` of this repo. Scans the working tree AND the
# full commit history — a public repo carries its history forever, so a
# secret committed once and "fixed" later is still in the history anyone
# can read. Every file in the repo is in scope, this script and its own
# test included: nothing here is allowed to be the exception that leaks.
#
# Checks (any hit stops the push, exit 1):
#   - a Sui private key (`suiprivkey1...`)
#   - a Discord webhook URL
#   - an Anthropic API key (`sk-ant-...`)
#   - a bare 64-hex-character string not prefixed by `0x` (catches a raw
#     Ed25519 key — the MemWal delegate key and the gardener's own Sui key are
#     both this shape; legitimate Sui addresses/object ids in this codebase
#     always carry the `0x` prefix, so this heuristic should not false-positive
#     on those)
#   - a long random-looking token near a key-sounding word (best-effort catch
#     for the Tatum API key: its exact published shape was not confirmed as of
#     writing, so this is deliberately broad — tighten it once the real shape
#     is known)
#   - any line in --forbidden-patterns (operator's real name, the private
#     repo's name, or anything else that should never appear here), except
#     one passed to --allow
#   - any line in --forbidden-addresses (the operator's non-public account
#     addresses), except one passed to --allow
#   - any commit whose author name or email is not the one named by
#     --author-name / --author-email
#
# Usage:
#   precheck-public.sh --forbidden-patterns <file> --forbidden-addresses <file> \
#     --author-name <name> --author-email <email> [--allow <value>]...
#
# Both <file> arguments: one value per line (a word, a phrase, or an address).
# Pass them from outside this repo — e.g. a line listing the operator's real
# name, and a file holding the private backing repo's non-public account
# table — so neither the values nor where they come from are ever written
# into this (public) repo's own source.
#
# Prints the name of each failed check and how many hits, never the matched
# text itself — the point of this script is to keep secrets out of what gets
# published, so its own output must not become the leak.
set -eu

FORBIDDEN_PATTERNS=""
FORBIDDEN_ADDRESSES=""
AUTHOR_NAME=""
AUTHOR_EMAIL=""
ALLOWED=""
while [ $# -gt 0 ]; do
  case "$1" in
    --forbidden-patterns) FORBIDDEN_PATTERNS="$2"; shift 2 ;;
    --forbidden-addresses) FORBIDDEN_ADDRESSES="$2"; shift 2 ;;
    --author-name) AUTHOR_NAME="$2"; shift 2 ;;
    --author-email) AUTHOR_EMAIL="$2"; shift 2 ;;
    --allow) ALLOWED="$ALLOWED $2"; shift 2 ;;
    *) echo "precheck-public: unknown argument: $1" >&2; exit 2 ;;
  esac
done

for required in "FORBIDDEN_PATTERNS:--forbidden-patterns" "FORBIDDEN_ADDRESSES:--forbidden-addresses" "AUTHOR_NAME:--author-name" "AUTHOR_EMAIL:--author-email"; do
  var="${required%%:*}"
  flag="${required#*:}"
  eval "val=\${$var}"
  if [ -z "$val" ]; then
    echo "precheck-public: $flag is required" >&2
    exit 2
  fi
done
for f in "$FORBIDDEN_PATTERNS" "$FORBIDDEN_ADDRESSES"; do
  if [ ! -f "$f" ]; then
    echo "precheck-public: $f does not exist" >&2
    exit 2
  fi
done

REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT"

fail=0
note() {
  echo "precheck-public: FAIL — $1"
  fail=1
}

# Everything ever committed, concatenated once. `git log -p` covers commit
# content; `--all` covers every branch and tag, not just the current one.
ALL_HISTORY=$(mktemp)
# The working tree: exactly the files that could be pushed or staged — what
# `git ls-files` already knows to be tracked, plus anything untracked that
# `.gitignore` does not exclude (it could still be `git add`ed before a
# push). This sidesteps hand-rolled directory excludes entirely: node_modules
# and dist are never listed because `.gitignore` already covers them.
TREE_FILES=$(mktemp)
trap 'rm -f "$ALL_HISTORY" "$TREE_FILES"' EXIT
git log --all -p --full-history > "$ALL_HISTORY"
git ls-files --cached --others --exclude-standard > "$TREE_FILES"

scan() {
  # $1: grep -E pattern, $2: human label
  count=0
  if [ -s "$TREE_FILES" ]; then
    count=$(xargs -I{} grep -IoE "$1" {} < "$TREE_FILES" 2>/dev/null | wc -l | tr -d ' ')
  fi
  hist_count=$(grep -oE "$1" "$ALL_HISTORY" | wc -l | tr -d ' ')
  if [ "$count" != 0 ] || [ "$hist_count" != 0 ]; then
    note "$2 (tree: $count, history: $hist_count)"
  fi
}

scan 'suiprivkey1[0-9a-zA-Z]+' "a Sui private key"
scan 'https://[a-zA-Z0-9.-]*discord(app)?\.com/api/webhooks/[A-Za-z0-9_/-]+' "a Discord webhook URL"
scan 'sk-ant-[A-Za-z0-9_-]{10,}' "an Anthropic API key"
scan '[^0-9a-fA-Fx][0-9a-fA-F]{64}([^0-9a-fA-F]|$)' "a bare 64-hex-character string (possible raw key)"
scan '(api[_-]?key|apikey|secret|token)["'"'"']?\s*[:=]\s*["'"'"'][A-Za-z0-9_-]{20,}' "a token assigned to a key-sounding name"

# $1: file of forbidden literal values (one per line), $2: human label for a hit
check_forbidden_file() {
  for value in $(grep -v '^\s*$' "$1"); do
    skip=0
    for a in $ALLOWED; do
      [ "$value" = "$a" ] && skip=1
    done
    [ "$skip" = 1 ] && continue
    found=0
    if [ -s "$TREE_FILES" ] && xargs -I{} grep -IqF "$value" {} < "$TREE_FILES" 2>/dev/null; then found=1; fi
    if [ "$found" = 0 ] && grep -qF "$value" "$ALL_HISTORY"; then found=1; fi
    if [ "$found" = 1 ]; then
      note "$2 (not in --allow)"
    fi
  done
}

check_forbidden_file "$FORBIDDEN_PATTERNS" "a forbidden word or phrase appears"
check_forbidden_file "$FORBIDDEN_ADDRESSES" "a non-public account address appears"

# Every commit's author name AND email must match exactly.
BAD_AUTHORS=$(git log --all --format='%an <%ae>' | sort -u | grep -vF "$AUTHOR_NAME <$AUTHOR_EMAIL>" || true)
if [ -n "$BAD_AUTHORS" ]; then
  n=$(echo "$BAD_AUTHORS" | wc -l | tr -d ' ')
  note "$n commit author identity(ies) other than the one named by --author-name/--author-email"
fi

if [ "$fail" = 1 ]; then
  echo "precheck-public: one or more checks failed. Do not push." >&2
  exit 1
fi
echo "precheck-public: all checks passed."
