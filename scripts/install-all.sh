#!/bin/sh
# Install every bb plugin in packages/ (idempotent).
# Usage: bash scripts/install-all.sh   (or: pnpm plugins:install)
set -eu

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ok=0
for pkg in "$REPO_DIR"/packages/bb-plugin-*/; do
	[ -d "$pkg" ] || continue
	name="$(basename "$pkg")"
	if [ "$name" = "bb-plugin-telemetry" ]; then
		echo "==> skipping $name (folded into bb-plugin-sessions)"
		continue
	fi
	echo "==> bb plugin install $name"
	if bb plugin install "$pkg" --yes; then
		echo "    installed: $name"
		ok=$((ok + 1))
	else
		echo "    FAILED: $name" >&2
	fi
done

echo
echo "Installed $ok plugin(s). Installed plugins from this repo:"
bb plugin list 2>/dev/null | grep -E "^(auto-new-tab|cobalt2|ds4|excalidraw|omp|plannotator|prime-agent|sessions)@|bb-plugin" || true
