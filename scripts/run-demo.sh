#!/usr/bin/env bash
# Jalankan demo Mandat (validator + deploy + demo.ts saja).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$PATH"
export MANDAT_DEMO="${MANDAT_DEMO:-1}"

DEMO_SCRIPT='npx ts-mocha -p ./tsconfig.json -t 1000000 tests/demo.ts'
ORIG="$(grep '^test = ' Anchor.toml)"

restore_toml() {
  sed -i '' "s|^test = .*|${ORIG}|" Anchor.toml
}

trap restore_toml EXIT
sed -i '' "s|^test = .*|test = \"${DEMO_SCRIPT}\"|" Anchor.toml

anchor test --validator legacy "$@"
