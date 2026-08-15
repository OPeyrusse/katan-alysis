#!/bin/sh
# Validates an Allium spec right after Claude Code writes or edits it.
#
# Wired as a PostToolUse hook in .claude/settings.json. Exits 2 with the
# checker output on stderr when the edit introduced an error, so the
# agent sees the diagnostic and fixes it before moving on. Warnings and
# info diagnostics are not blocking: an external entity without a
# governing spec, or a field only referenced from a predicate, is a
# normal state for this spec.
#
# Install the checker with `cargo install allium-cli`. Without it the
# hook is a no-op.

input=$(cat)

file=$(printf '%s' "$input" |
    sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' |
    head -n 1)

case "$file" in
*.allium) ;;
*) exit 0 ;;
esac

command -v allium >/dev/null 2>&1 || exit 0

output=$(allium check "$file" 2>&1)

if printf '%s' "$output" | grep -q '"severity"[[:space:]]*:[[:space:]]*"error"'; then
    printf 'allium check reported errors in %s:\n%s\n' "$file" "$output" >&2
    exit 2
fi

exit 0
