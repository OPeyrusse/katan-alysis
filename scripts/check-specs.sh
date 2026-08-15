#!/bin/sh
# Validates the Allium specifications: structural diagnostics plus the
# process-level analysis (data flow, reachability, deadlocks, conflicts).
#
# Fails on errors and on process findings. Warnings and info diagnostics
# are counted but not fatal: external entities without a governing spec
# (the JFR file, the analyst) and fields only referenced from a predicate
# are the normal state of this spec, not something to fix.
#
# Usage: scripts/check-specs.sh [path...]        (default: specs)
#
# The editor hook (.claude/hooks/allium-check.sh) applies a lighter
# policy on a single file — errors only — so that a spec being edited
# across several writes is not blocked on findings that the next write
# resolves. This script is the gate that CI runs on the whole spec.

set -eu

if [ "$#" -eq 0 ]; then
    set -- specs
fi

if ! command -v allium >/dev/null 2>&1; then
    echo "allium not found on PATH; install it with 'cargo install allium-cli'" >&2
    exit 1
fi

report=$(mktemp)
trap 'rm -f "$report"' EXIT

# Exit code 0 = no findings, 1 = findings produced, 2 = nothing to check.
status=0
allium analyse "$@" >"$report" 2>&1 || status=$?

if [ "$status" -gt 1 ]; then
    cat "$report" >&2
    echo "allium analyse could not run (exit $status)" >&2
    exit 1
fi

count() {
    grep -c "\"severity\"[[:space:]]*:[[:space:]]*\"$1\"" "$report" || true
}

errors=$(count error)
warnings=$(count warning)
infos=$(count info)

echo "specs: $errors error(s), $warnings warning(s), $infos info"

if [ "$errors" -ne 0 ] || [ "$status" -ne 0 ]; then
    cat "$report" >&2
    exit 1
fi
