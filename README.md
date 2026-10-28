# Mandat

> Beri agent Anda mandat, bukan kunci.

Custody & policy layer untuk AI agent di Solana. Agent mendapat *session key*
terdelegasi dengan batasan yang ditegakkan **on-chain** — limit harian,
limit per-transaksi, whitelist tujuan, jam operasi, dan kill switch milik
pemilik. Agent yang di-compromise pun tidak bisa melebihi mandatnya.

Dibangun untuk Colosseum Fall Hackathon 2026 (28 Sep – 2 Nov).

## Arsitektur

```
Agent (LangChain / MCP / bot kustom)
  └── Mandat SDK / MCP server          ← integrasi 5 menit
        └── Program Anchor on-chain
              ├── Vault PDA            ← memegang dana
              ├── Policy account       ← aturan, tak bisa dilewati off-chain
              └── Session PDA          ← key ephemeral per-agent
```

## Instruksi program

| Instruksi | Siapa | Fungsi |
|---|---|---|
| `initialize_vault` | Owner | Buat vault + policy (limit, whitelist, jam aktif) |
| `deposit` / `withdraw` | Owner | Kelola dana vault |
| `create_session` | Owner | Delegasikan session key ber-scope ke agent |
| `revoke_session` | Owner | Cabut satu session seketika |
| `set_frozen` | Owner | Kill switch — bekukan semua aktivitas agent |
| `update_policy` | Owner | Ubah aturan |
| `execute_transfer` | **Agent** | Transfer yang melewati seluruh policy check |

## Development

Prasyarat: Rust, [Solana CLI](https://solana.com/docs/intro/installation),
[Anchor](https://www.anchor-lang.com/docs/installation), Node 22+.

```bash
# Build program
anchor build

# Sinkronkan program ID hasil build ke deklarasi kode
anchor keys sync

# Jalankan test (memutar validator lokal otomatis)
# Anchor 1.0 default memakai Surfpool; gunakan legacy jika belum terinstal:
anchor test --validator legacy

# Atau via npm:
npm test
```

## Devnet

Program ID: `2nJTE7vKVaV3pum9jV9NTYP3MPMqAx2GojqxFQn9W2kz`

Explorer: https://explorer.solana.com/address/2nJTE7vKVaV3pum9jV9NTYP3MPMqAx2GojqxFQn9W2kz?cluster=devnet

```bash
# 1. Fund wallet (~2 SOL needed)
npm run devnet:fund
# Jika rate-limited, manual: https://faucet.solana.com/

# 2. Deploy program (butuh RPC stabil — set Helius/QuickNode jika 429)
#    export SOLANA_RPC_URL="https://devnet.helius-rpc.com/?api-key=YOUR_KEY"
npm run devnet:deploy

# 3. Run live demo on devnet (prints explorer links)
npm run devnet:demo
```

Wallet devnet saat ini: jalankan `solana address` setelah `solana config set --url devnet`.

## Roadmap (scope hackathon 5 minggu)

- [x] Minggu 1 — Program inti: vault, policy, session, kill switch (7/7 test lulus)
- [ ] Minggu 2 — Deploy devnet, whitelist program (CPI), event indexing
- [ ] Minggu 3 — TypeScript SDK + MCP server + adapter x402
- [ ] Minggu 4 — Dashboard monitoring & kontrol
- [ ] Minggu 5 — Video demo, docs, submission

Di luar scope MVP: mainnet, audit formal, multi-chain, TEE signing.
