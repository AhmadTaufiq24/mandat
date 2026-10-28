#!/usr/bin/env bash
# Fund devnet wallet via CLI airdrop (with retries) or devnet-pow fallback.

set -euo pipefail

export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$PATH"

solana config set --url devnet >/dev/null
PUBKEY="$(solana address)"

echo "Devnet wallet: $PUBKEY"
echo "Target: ~3 SOL (deploy + demo)"
echo ""

balance_lamports() {
  solana balance "$PUBKEY" --lamports 2>/dev/null | awk '{print $1}'
}

show_balance() {
  solana balance "$PUBKEY"
}

BAL="$(balance_lamports)"
show_balance

if [ "${BAL:-0}" -ge 3000000000 ]; then
  echo "Already funded."
  exit 0
fi

echo ""
echo "Trying solana airdrop..."
for amount in 2 1 0.5; do
  if solana airdrop "$amount" "$PUBKEY" 2>/dev/null; then
    sleep 3
    show_balance
    BAL="$(balance_lamports)"
    if [ "${BAL:-0}" -ge 3000000000 ]; then
      exit 0
    fi
  fi
  sleep 5
done

if command -v devnet-pow >/dev/null 2>&1; then
  echo ""
  echo "CLI faucet rate-limited. Trying devnet-pow (proof-of-work)..."
  MIN_BAL=1500000000
  for i in $(seq 1 10); do
    echo "Mine attempt $i..."
    if devnet-pow mine -d 1 --reward 0.05 --no-infer -t 500000000 2>&1; then
      show_balance
      BAL="$(balance_lamports)"
      if [ "${BAL:-0}" -ge "$MIN_BAL" ]; then
        echo "Enough SOL for deploy."
        exit 0
      fi
    fi
    sleep 3
  done
fi

echo ""
echo "Automatic funding failed (devnet faucet rate limit)."
echo ""
echo "Manual step — open https://faucet.solana.com/"
echo "  1. Select Devnet"
echo "  2. Paste wallet: $PUBKEY"
echo "  3. Request 2 SOL (repeat once if needed)"
echo ""
echo "Then run:"
echo "  npm run devnet:deploy"
echo "  npm run devnet:demo"
exit 1
