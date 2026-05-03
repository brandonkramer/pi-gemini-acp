#!/bin/bash
set -euo pipefail

# ---------------------------------------------------------------------------
# develop.sh — temporary local-dev ↔ npm toggle for the Pi extension
#
# Usage:
#   ./scripts/develop.sh link        # symlink local copy + uninstall npm version
#   ./scripts/develop.sh unlink      # remove symlink + reinstall npm version
#   ./scripts/develop.sh status      # show current installation state
#
# Pi loads BOTH the npm-installed extension AND extensions placed in
# ~/.pi/agent/extensions/ at the same time, which causes tool-name
# conflicts. This script handles the symlink AND runs `pi uninstall` /
# `pi install` for you so only one version is active at a time.
#
# After link/unlink, you still need to run `/reload` inside the Pi CLI
# to pick up the changes (slash-commands can only be run from inside
# the Pi REPL).
# ---------------------------------------------------------------------------

readonly PROJECT_NAME="pi-gemini-acp"
readonly SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
readonly PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly EXT_DIR="${HOME}/.pi/agent/extensions"
readonly SYMLINK="${EXT_DIR}/${PROJECT_NAME}"
readonly NPM_NAME="npm:${PROJECT_NAME}"

# --- helpers ----------------------------------------------------------------

die() {
	echo "[dev] ERROR: $*" >&2
	exit 1
}
info() { echo "[dev] $*"; }
pi_cmd() { echo "    Pi >   $*"; }

assert_project() {
	[[ -d "${PROJECT_DIR}" ]] || die "project not found: ${PROJECT_DIR}"
	[[ -f "${PROJECT_DIR}/package.json" ]] || die "no package.json in ${PROJECT_DIR}"
	[[ -d "${PROJECT_DIR}/src" ]] || die "no src/ in ${PROJECT_DIR}"
}

ensure_ext_dir() {
	mkdir -p "${EXT_DIR}" || die "cannot create ${EXT_DIR}"
}

require_pi_cli() {
	command -v pi >/dev/null 2>&1 || die "pi CLI not found on PATH"
}

# Returns 0 if the npm extension appears installed in Pi settings.
npm_extension_installed() {
	pi list 2>/dev/null | grep -q "${NPM_NAME}"
}

# --- subcommands ------------------------------------------------------------

cmd_link() {
	require_pi_cli
	assert_project
	ensure_ext_dir

	# Step 1: create the dev symlink.
	if [[ -L "${SYMLINK}" ]]; then
		local target
		target=$(readlink "${SYMLINK}")
		info "already symlinked -> ${target}"
	elif [[ -e "${SYMLINK}" ]]; then
		die "non-symlink path exists at ${SYMLINK}; remove it manually if intended."
	else
		ln -s "${PROJECT_DIR}" "${SYMLINK}" || die "failed to create symlink"
		info "linked ${PROJECT_DIR}"
	fi

	# Step 2: uninstall the npm version to avoid tool conflicts.
	if npm_extension_installed; then
		info "uninstalling npm version (${NPM_NAME})..."
		pi uninstall "${NPM_NAME}" || die "pi uninstall failed"
	else
		info "npm version not installed; nothing to uninstall"
	fi

	# Step 3: tell the user to /reload inside Pi.
	echo
	info "DONE. Now run inside the Pi CLI:"
	echo
	pi_cmd "/reload"
	echo
	info "Verify with: /gemini-config status"
}

cmd_unlink() {
	require_pi_cli

	# Step 1: remove the dev symlink.
	if [[ -L "${SYMLINK}" ]]; then
		local target
		target=$(readlink "${SYMLINK}")
		rm "${SYMLINK}" || die "failed to remove symlink"
		info "removed symlink -> ${target}"
	else
		info "no dev symlink at ${SYMLINK}"
	fi

	# Step 2: re-install the npm version.
	if npm_extension_installed; then
		info "npm version already installed; skipping install"
	else
		info "installing npm version (${NPM_NAME})..."
		pi install "${NPM_NAME}" || die "pi install failed"
	fi

	# Step 3: tell the user to /reload inside Pi.
	echo
	info "DONE. Now run inside the Pi CLI:"
	echo
	pi_cmd "/reload"
	echo
	info "Verify with: /gemini-config status"
}

cmd_status() {
	local symlink_state="none"
	if [[ -L "${SYMLINK}" ]]; then
		symlink_state="symlinked"
	elif [[ -e "${SYMLINK}" ]]; then
		symlink_state="non-symlink"
	fi

	local npm_state="not installed"
	if command -v pi >/dev/null 2>&1 && npm_extension_installed; then
		npm_state="installed"
	fi

	echo "dev symlink: ${symlink_state}  (${SYMLINK})"
	if [[ "${symlink_state}" == "symlinked" ]]; then
		echo "  target:    $(readlink "${SYMLINK}")"
	fi
	echo "npm package: ${npm_state}  (${NPM_NAME})"
	echo

	if [[ "${symlink_state}" == "symlinked" && "${npm_state}" == "installed" ]]; then
		echo "WARNING: both dev symlink and npm version are active."
		echo "Tool conflicts will occur. Run: ./scripts/develop.sh link"
	elif [[ "${symlink_state}" == "symlinked" ]]; then
		echo "state: DEV (local copy active)"
	elif [[ "${npm_state}" == "installed" ]]; then
		echo "state: NPM (published version active)"
	else
		echo "state: NONE (extension not active anywhere)"
	fi
}

cmd_help() {
	cat <<'EOF'
Usage: ./scripts/develop.sh <command>

Commands:
  link      Symlink local project into Pi extensions AND uninstall the
            npm version to avoid tool conflicts. Tells you to run /reload.
  unlink    Remove dev symlink AND re-install the npm version. Tells
            you to run /reload.
  status    Show whether dev symlink and/or npm version are active.
  help      Show this message.

Why this is needed:
  Pi loads npm-installed extensions AND symlinks in ~/.pi/agent/extensions/
  at the same time. Both registering identical tool names causes conflicts
  ("Tool 'gemini_search' conflicts with ..."). This script makes sure only
  one version is active at a time.

Typical flow:
  1. Terminal: ./scripts/develop.sh link
  2. Pi CLI:   /reload
  3. Pi CLI:   /gemini-config status   (test the dev version)
  4. Terminal: ./scripts/develop.sh unlink
  5. Pi CLI:   /reload

The project directory is detected automatically from the script's
location (scripts/ → project root).
EOF
}

# --- main -------------------------------------------------------------------

COMMAND="${1:-help}"

case "${COMMAND}" in
link) cmd_link ;;
unlink) cmd_unlink ;;
status) cmd_status ;;
help | --help | -h) cmd_help ;;
*) die "unknown command: ${COMMAND}. Try 'help'." ;;
esac
