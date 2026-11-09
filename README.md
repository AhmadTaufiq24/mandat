# Mandat

> Beri agent Anda mandat, bukan kunci.

Custody and policy layer for AI agents on Solana. The owner keeps funds in a program-controlled vault and gives the agent a scoped, expiring session key. Per-transfer limit, daily limit, destination whitelist, operating hours, and revocation are enforced on-chain. Even a compromised agent cannot spend outside its mandate.

Built for the [Encode Club Solana Hackathon](https://www.encode.club/) 2026.

| | |
|---|---|
| **Network** | Solana devnet |
| **Program ID** | `2nJTE7vKVaV3pum9jV9NTYP3MPMqAx2GojqxFQn9W2kz` |
| **Explorer** | https://explorer.solana.com/address/2nJTE7vKVaV3pum9jV9NTYP3MPMqAx2GojqxFQn9W2kz?cluster=devnet |
| **Framework** | Anchor 1.0.2 |
| **Demo video** | (link coming) |

## How Solana is used

- **PDAs hold vault and session state.** The vault PDA (seeds `["vault", owner]`) holds funds and the spending policy. Each session PDA (seeds `["session", vault, session_signer]`) binds an agent's ephemeral key to expiry and limits.
- **One instruction runs the full policy check.** Every agent spend goes through `execute_transfer` (SOL) or `execute_token_transfer` (SPL). Both call the shared `enforce_policy` function. If any check fails, the transaction fails and nothing moves.
- **Low fees and fast confirmation** make an on-chain check on every agent payment practical.

```
Owner wallet
  └── initialize_vault / deposit / update_policy / create_session / revoke / freeze
        └── Vault PDA  (funds + policy)
              └── Session PDA  (scoped agent key)
                    └── Agent signs execute_transfer / execute_token_transfer
                          └── enforce_policy → destination
```

## Policy checks

Every agent transfer runs these checks inside `enforce_policy`:

| Check | Failure |
|---|---|
| Vault not frozen (`set_frozen`) | `VaultFrozen` |
| Session not revoked | `SessionRevoked` |
| Session not expired | `SessionExpired` |
| Current UTC hour inside the active window (`start == end` disables) | `OutsideActiveHours` |
| Destination on whitelist when restriction is on | `DestinationNotAllowed` |
| Amount ≤ vault and session per-transfer limits | `PerTxLimitExceeded` |
| Today's spend + amount ≤ vault and session daily limits (UTC calendar day) | `DailyLimitExceeded` |
| Vault keeps its rent-exempt minimum (SOL path) | `InsufficientFunds` |

## Instructions

| Instruction | Signer | What it does |
|---|---|---|
| `initialize_vault` | Owner | Create vault PDA with SOL spending policy |
| `deposit` | Owner | Move SOL into the vault |
| `withdraw` | Owner | Owner-only SOL withdrawal (not subject to agent policy) |
| `update_policy` | Owner | Replace vault SOL policy (preserves today's spend counter) |
| `set_frozen` | Owner | Freeze or unfreeze all agent activity on the vault |
| `create_session` | Owner | Issue a scoped, expiring session key to an agent (max 30 days) |
| `revoke_session` | Owner | Revoke a session immediately |
| `close_session` | Owner | Close a session account and return rent to the owner |
| `execute_transfer` | **Agent (session key)** | Transfer SOL from the vault, gated by `enforce_policy` |
| `configure_token_policy` | Owner | Allow one classic SPL mint and set vault-wide token limits |
| `set_session_token_limits` | Owner | Set a session's token limits (`0` / `0` disables the token path) |
| `execute_token_transfer` | **Agent (session key)** | Transfer classic SPL Token from a vault-owned token account, gated by `enforce_policy` (separate token counters; whitelist checked against the destination wallet) |
| `withdraw_token` | Owner | Owner-only token withdrawal (not subject to agent policy) |

`PolicyArgs` = `{ per_tx_limit, daily_limit, active_hour_start, active_hour_end, restrict_destinations, allowed_destinations }` (max 16 destinations).

The SPL path uses **classic SPL Token only** (not Token-2022).

## Development

### Prerequisites

- Rust
- [Solana CLI](https://solana.com/docs/intro/installation)
- [Anchor CLI 1.0.2](https://www.anchor-lang.com/docs/installation)
- Node.js 22+

### Build and test (localnet)

```bash
git clone https://github.com/AhmadTaufiq24/mandat.git
cd mandat
npm install

# Build the program
anchor build

# Sync the built program ID into the source declare_id! if it changed
anchor keys sync

# Run the test suite against a local validator
# Anchor 1.0 defaults to Surfpool; use legacy for solana-test-validator:
anchor test --validator legacy

# Or via npm (same command):
npm test
```

Tests live in `tests/` (`mandat.ts` for the SOL path, `token.ts` for the SPL path, plus local and devnet demos).

### Devnet

Program ID: `2nJTE7vKVaV3pum9jV9NTYP3MPMqAx2GojqxFQn9W2kz`

Explorer: https://explorer.solana.com/address/2nJTE7vKVaV3pum9jV9NTYP3MPMqAx2GojqxFQn9W2kz?cluster=devnet

The program is already deployed on devnet from this repo (`523eb08`). To fund a wallet, redeploy, or re-run the demo yourself:

```bash
# 1. Fund a wallet (~2 SOL)
npm run devnet:fund
# If rate-limited, use https://faucet.solana.com/

# 2. Deploy (needs a stable RPC; public endpoints often 429)
#    export SOLANA_RPC_URL="https://devnet.helius-rpc.com/?api-key=YOUR_KEY"
npm run devnet:deploy

# 3. Live demo on the deployed program (prints Explorer links)
npm run devnet:demo
```

Copy `.env.example` to `.env` if you use a private RPC. Do not commit `.env` or `*.keypair.json`.

## Demo video

Demo video: (link coming)

The planned demo shows, on devnet: vault and policy setup, issuing a session key, an allowed transfer, on-chain rejections (`PerTxLimitExceeded`, `DestinationNotAllowed`), and revocation (`SessionRevoked`).

## Security

Internal security review (not a third-party audit) on 28-29 Oct 2026: static review plus adversarial tests on LiteSVM.

**Fixed in commit `6a0cc83` (confirmed with exploit tests):**

- `update_policy` no longer resets the daily spend counter
- Daily rollover is monotonic (`day > last_day`), so a clock that moves backwards cannot refresh the limit
- Session parameters are validated: expiry max 30 days, and `per_tx_limit` must not exceed `daily_limit`
- `close_session` is owner-only and returns rent to the owner

**Known limitations:**

- Daily limits use the UTC calendar day, so around UTC midnight spend can reach up to 2× the limit
- Per-transfer limits apply per instruction; several transfers can share one transaction
- Without a whitelist, destinations are unrestricted
- Operating hours use UTC
- Program upgrade authority is a single key on devnet; multisig or immutable is planned before mainnet
- The SPL token path is newer and under continued internal review

Not production-ready: devnet only, no third-party audit, no mainnet deployment.

## Roadmap

- [x] Core program: vault, policy, session, freeze, revoke, `execute_transfer`
- [x] Shared `enforce_policy`; `close_session`; expanded localnet tests
- [x] Classic SPL Token path: `configure_token_policy`, `set_session_token_limits`, `execute_token_transfer`, `withdraw_token`
- [x] Devnet deploy
- [ ] TypeScript SDK and MCP server (separate kit repo)
- [ ] x402 payment flow on top of the SPL path
- [ ] Monitoring dashboard
- [ ] Multisig / immutable upgrade authority, then third-party audit and mainnet

## License

Apache-2.0 (see `package.json`).
