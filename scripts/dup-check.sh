#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ALLOWLIST="$ROOT/dup-check.allowlist"
THRESHOLD="0.85"
MIN_LINES="5"

# Self-install binary if missing
bash "$ROOT/scripts/similarity.sh" >/dev/null

# Run the tool, capture full output
output=$("$ROOT/.bin/similarity-ts" src --threshold "$THRESHOLD" --min-lines "$MIN_LINES" 2>&1)

# Print raw output for visibility
echo "$output"

# Extract only the Function Similarity section (up to the Type Similarity header)
func_section=$(echo "$output" | awk '/^=== Function Similarity ===$/{p=1;next} /^=== Type Similarity ===$/{p=0} p')

# If no function section found, something is wrong with the format
if [ -z "$func_section" ]; then
	echo ""
	echo "::error::dup-check: could not parse function similarity section. similarity-ts output format may have changed." >&2
	exit 2
fi

# Build a list of allowlisted pair keys and cluster globs
declare -a allowlisted_pairs
declare -a cluster_globs

while IFS= read -r line || [ -n "$line" ]; do
	# Skip comments and blank lines
	[[ "$line" =~ ^[[:space:]]*# ]] && continue
	[[ "$line" =~ ^[[:space:]]*$ ]] && continue

	# Reject lines without a comment
	if [[ ! "$line" =~ \# ]]; then
		echo "::error::dup-check allowlist line missing comment: $line" >&2
		exit 2
	fi

	if [[ "$line" =~ ^pair: ]]; then
		# Extract the pair key (everything between "pair:" and the first "  #")
		key=$(echo "$line" | sed -n 's/^pair:\([^#]*\)[[:space:]]*#.*/\1/p' | sed 's/[[:space:]]*$//')
		allowlisted_pairs+=("$key")
	elif [[ "$line" =~ ^cluster: ]]; then
		# Extract the glob (everything between "cluster:" and the first "  #")
		glob=$(echo "$line" | sed -n 's/^cluster:\([^#]*\)[[:space:]]*#.*/\1/p' | sed 's/[[:space:]]*$//')
		cluster_globs+=("$glob")
	fi
done <"$ALLOWLIST"

# Normalize a pair: sort the two sides alphabetically so order doesn't matter
normalize_pair() {
	local a="$1"
	local b="$2"
	if [[ "$a" < "$b" ]]; then
		echo "${a}||${b}"
	else
		echo "${b}||${a}"
	fi
}

# Check if a pair matches any allowlisted pair
is_pair_allowed() {
	local pair_key="$1"
	for allowed in "${allowlisted_pairs[@]}"; do
		if [ "$pair_key" = "$allowed" ]; then
			return 0
		fi
	done
	return 1
}

# Check if a symbol name matches a glob (using bash pattern matching)
matches_glob() {
	local symbol="$1"
	local glob="$2"
	case "$symbol" in
	$glob) return 0 ;;
	*) return 1 ;;
	esac
}

# Global array for current cluster symbols (avoids bash 3.x nameref limitation)
declare -a current_cluster_symbols

# Check if ALL symbols in current_cluster_symbols match any cluster glob
is_cluster_allowed() {
	for glob in "${cluster_globs[@]}"; do
		local all_match=1
		for sym in "${current_cluster_symbols[@]}"; do
			if ! matches_glob "$sym" "$glob"; then
				all_match=0
				break
			fi
		done
		if [ "$all_match" -eq 1 ]; then
			return 0
		fi
	done
	return 1
}

remaining=0

# Pre-process the function section with awk to emit one normalized pair per line.
# Format: "pathA:symbolA||pathB:symbolB"
# This avoids nested-read issues inside a while-read loop.
pair_list=$(echo "$func_section" | awk '
function parse_member(line, path_sym) {
	sub(/^[[:space:]]+src\//, "", line)           # -> "foo.ts:42-79 symbolName"
	pos = index(line, ":")
	if (pos <= 0) return 0
	path = "src/" substr(line, 1, pos - 1)         # -> "src/foo.ts"
	rest = substr(line, pos + 1)                   # -> "42-79 symbolName"
	pos2 = index(rest, " ")
	if (pos2 <= 0) return 0
	symbol = substr(rest, pos2 + 1)                # -> "symbolName"
	path_sym[1] = path
	path_sym[2] = symbol
	return 1
}

function emit_cluster_pairs() {
	for (i=0; i<cluster_idx; i++) {
		for (j=i+1; j<cluster_idx; j++) {
			a = cluster_paths[i] ":" cluster_syms[i]
			b = cluster_paths[j] ":" cluster_syms[j]
			if (a < b) print a "||" b
			else print b "||" a
		}
	}
	cluster_idx = 0
}

BEGIN { cluster_idx=0 }
/^[[:space:]]*$/ { next }
/^Cluster[[:space:]]+[0-9]+:/ {
	emit_cluster_pairs()   # flush any previous cluster
	next
}
/^[[:space:]]+src\/[^:]+:[0-9]+-[0-9]+[[:space:]]+/ {
	if (parse_member($0, m)) {
		cluster_paths[cluster_idx] = m[1]
		cluster_syms[cluster_idx] = m[2]
		cluster_idx++
	}
	next
}
/^Similarity:[[:space:]]/ {
	# This line may follow a cluster (flush it) or be a standalone pair header
	emit_cluster_pairs()
	getline line_a
	getline line_b
	if (parse_member(line_a, ma) && parse_member(line_b, mb)) {
		a = ma[1] ":" ma[2]
		b = mb[1] ":" mb[2]
		if (a < b) print a "||" b
		else print b "||" a
	}
	next
}
END {
	emit_cluster_pairs()
}
')

# Process each pair
while IFS= read -r pair_key; do
	# Skip blank lines
	[[ -z "$pair_key" ]] && continue

	# Check cluster glob allowlist first: if both symbols in the pair match a cluster glob,
	# the pair is allowed. We need to extract the symbol names.
	is_allowed=0
	for glob in "${cluster_globs[@]}"; do
		# Extract symbol names from the pair key
		sym_a="${pair_key%%||*}"
		sym_b="${pair_key##*||}"
		sym_a="${sym_a##*:}"
		sym_b="${sym_b##*:}"
		if matches_glob "$sym_a" "$glob" && matches_glob "$sym_b" "$glob"; then
			is_allowed=1
			break
		fi
	done

	if [ "$is_allowed" -eq 1 ]; then
		continue
	fi

	if ! is_pair_allowed "$pair_key"; then
		echo "  unallowlisted pair: $pair_key" >&2
		remaining=$((remaining + 1))
	fi
done <<<"$pair_list"

if [ "$remaining" -gt 0 ]; then
	echo ""
	echo "::error::dup-check found $remaining unallowlisted duplicate(s). Either fix the duplicate, or add an entry to dup-check.allowlist with a reason." >&2
	exit 1
fi

echo ""
echo "dup-check: clean (after allowlist)"
