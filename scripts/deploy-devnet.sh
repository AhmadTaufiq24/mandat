#!/usr/bin/env bash
# Deploy Mandat to devnet.
#
# Public RPC (api.devnet.solana.com) rate-limits heavily. For reliable deploys:
#   export SOLANA_RPC_URL="https://devnet.helius-rpc.com/?api-key=YOUR_KEY"
# Free key: https://dashboard.helius.dev/

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$PATH"
RPC="${SOLANA_RPC_URL:-https://api.devnet.solana.com}"

retry() {
  local max="$1"
  shift
  local i=1
  until "$@"; do
    if [ "$i" -ge "$max" ]; then
      return 1
    fi
    echo "  retry $i/$max (waiting 30s — avoid 429 spam)..."
    sleep 30
    i=$((i + 1))
  done
}

echo "RPC: $RPC"
if [[ "$RPC" == *"api.devnet.solana.com"* ]]; then
  echo ""
  echo "WARNING: Public devnet RPC is rate-limited. If you see 429 errors,"
  echo "  get a free Helius key: https://dashboard.helius.dev/"
  echo "  export SOLANA_RPC_URL=\"https://devnet.helius-rpc.com/?api-key=YOUR_KEY\""
  echo ""
fi

solana config set --url "$RPC" >/dev/null

if [ "${CLOSE_BUFFERS:-0}" = "1" ]; then
  echo "Closing leftover deploy buffers..."
  retry 3 solana program close --buffers --url "$RPC" || echo "  (skipped — none found)"
  echo ""
fi

retry 3 solana balance --url "$RPC"

echo ""
echo "Building..."
anchor build >/dev/null

BAL="$(solana balance --url "$RPC" --lamports | awk '{print $1}')"
echo "Balance: $(solana balance --url "$RPC")"

if [ "${BAL:-0}" -lt 1500000000 ]; then
  echo ""
  echo "Need ~1.5 SOL. Run with CLOSE_BUFFERS=1 to recover SOL from failed deploys:"
  echo "  CLOSE_BUFFERS=1 npm run devnet:deploy"
  exit 1
fi

echo ""
echo "Deploying (2-5 min)..."
retry 3 solana program deploy target/deploy/mandat.so \
  --program-id target/deploy/mandat-keypair.json \
  --url "$RPC" \
  --use-rpc \
  --with-compute-unit-price 100000 \
  --max-sign-attempts 100

PROGRAM_ID="$(solana address -k target/deploy/mandat-keypair.json)"
echo ""
echo "Deployed!"
echo "  Program: $PROGRAM_ID"
echo "  Explorer: https://explorer.solana.com/address/${PROGRAM_ID}?cluster=devnet"
echo "  Balance: $(solana balance --url "$RPC")"
