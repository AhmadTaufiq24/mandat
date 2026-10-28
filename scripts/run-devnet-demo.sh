#!/usr/bin/env bash
# Run Mandat devnet demo (requires Helius or other devnet RPC).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Load .env if present (never commit this file)
if [ -f "$ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi

export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$PATH"

if [ -z "${SOLANA_RPC_URL:-}" ]; then
  echo "Error: SOLANA_RPC_URL is not set."
  echo ""
  echo "Create .env in project root:"
  echo '  SOLANA_RPC_URL="https://devnet.helius-rpc.com/?api-key=YOUR_KEY"'
  echo ""
  echo "Or export in terminal:"
  echo '  export SOLANA_RPC_URL="https://devnet.helius-rpc.com/?api-key=YOUR_KEY"'
  exit 1
fi

export ANCHOR_PROVIDER_URL="$SOLANA_RPC_URL"
export ANCHOR_WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}"

echo "RPC: $SOLANA_RPC_URL"
echo "Wallet: $ANCHOR_WALLET"
echo ""

npx ts-mocha -p ./tsconfig.json -t 1000000 tests/demo-devnet.ts "$@"
