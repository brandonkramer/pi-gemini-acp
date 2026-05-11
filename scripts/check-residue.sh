#!/usr/bin/env bash
# check-residue.sh
# Detects variant files left behind by AI agent debugging sessions, e.g.
# auth_v2.ts, component_fixed.tsx, utils_old.ts, rateLimiterEnhanced.ts.
#
# Runs in two passes over files newly added in this commit:
#   1. Residue-suffix check (error): filename matches a known debugging suffix.
#   2. Sibling check (warning): >2 files in the same dir share a base name.

set -euo pipefail

RESIDUE_PATTERN='_(old|new|v[0-9]+|backup|fixed|simple|enhanced|temp|wip|draft|orig|copy)\.'
EXIT_CODE=0

# Only flag NEW files; modifications to existing files are out of scope.
added_files=$(git diff --cached --name-only --diff-filter=A)
[ -z "$added_files" ] && exit 0

# Pass 1: residue suffix in filename
while IFS= read -r file; do
	[ -z "$file" ] && continue
	if echo "$file" | grep -qiE "$RESIDUE_PATTERN"; then
		echo "::error::Debugging residue detected: $file" >&2
		echo "  AI agents create variant files during debugging and forget to clean up." >&2
		echo "  If this is intentional, rename it to something descriptive." >&2
		echo "  If not, remove it and ensure the canonical file is correct." >&2
		echo "" >&2
		EXIT_CODE=1
	fi
done <<<"$added_files"

# Pass 2: sibling-name proliferation (warns only)
while IFS= read -r file; do
	[ -z "$file" ] && continue
	dir=$(dirname "$file")
	base=$(basename "$file" | sed -E 's/\.[^.]+$//' | sed -E 's/(Simple|Enhanced|New|Old|Fixed|Backup|V[0-9]+|Copy)$//')
	ext="${file##*.}"
	[ -z "$base" ] && continue
	[ "$base" = "$(basename "$file")" ] && continue # no extension stripped
	siblings=$(find "$dir" -maxdepth 1 -name "${base}*.${ext}" 2>/dev/null | wc -l | tr -d ' ')
	if [ "$siblings" -gt 2 ]; then
		echo "::warning::Multiple variants of '${base}' found in ${dir}:" >&2
		find "$dir" -maxdepth 1 -name "${base}*.${ext}" 2>/dev/null | sed 's/^/  /' >&2
		echo "  This often indicates AI debugging residue. Consider consolidating." >&2
		echo "" >&2
	fi
done <<<"$added_files"

exit $EXIT_CODE
