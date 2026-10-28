import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { assert } from "chai";
import { Mandat } from "../target/types/mandat";
import { expectMandatError } from "./helpers";

const DEMO = process.env.MANDAT_DEMO === "1";
const SOL = LAMPORTS_PER_SOL;

function pause(ms = 800) {
  return DEMO ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

function banner(title: string) {
  if (!DEMO) return;
  console.log("");
  console.log("─".repeat(60));
  console.log(`  ${title}`);
  console.log("─".repeat(60));
}

function step(n: number, text: string) {
  if (!DEMO) return;
  console.log(`\n[${n}/7] ${text}`);
}

function ok(text: string) {
  if (!DEMO) return;
  console.log(`      OK  ${text}`);
}

function fail(text: string) {
  if (!DEMO) return;
  console.log(`      BLOCKED  ${text}`);
}

function lamportsToSol(lamports: number) {
  return (lamports / SOL).toFixed(4);
}

describe(DEMO ? "Mandat — Live Demo" : "mandat", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Mandat as Program<Mandat>;
  const owner = provider.wallet.publicKey;

  const agentKey = Keypair.generate();
  const stranger = Keypair.generate();

  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), owner.toBuffer()],
    program.programId,
  );
  const [sessionPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("session"), vaultPda.toBuffer(), agentKey.publicKey.toBuffer()],
    program.programId,
  );

  const policy = {
    perTxLimit: new BN(0.5 * SOL),
    dailyLimit: new BN(1 * SOL),
    activeHourStart: 0,
    activeHourEnd: 0,
    restrictDestinations: false,
    allowedDestinations: [] as PublicKey[],
  };

  before(async () => {
    if (!DEMO) return;
    console.log("");
    console.log("  MANDAT — Custody & Policy Layer for AI Agents on Solana");
    console.log("  Beri agent Anda mandat, bukan kunci.");
    console.log("");
    console.log(`  Program : ${program.programId.toBase58()}`);
    console.log(`  Owner   : ${owner.toBase58()}`);
    console.log(`  Agent   : ${agentKey.publicKey.toBase58()} (session key)`);
    await pause(1200);
  });

  it("initializes a vault with a policy", async () => {
    step(1, "Owner membuat vault + policy on-chain");
    if (DEMO) {
      console.log("      Policy: max 0.5 SOL/tx, max 1 SOL/hari");
    }
    await program.methods.initializeVault(policy).rpc();
    const vault = await program.account.vault.fetch(vaultPda);
    assert.ok(vault.owner.equals(owner));
    assert.isFalse(vault.frozen);
    ok(`Vault PDA: ${vaultPda.toBase58().slice(0, 20)}...`);
    await pause();
  });

  it("accepts deposits", async () => {
    step(2, "Owner deposit 2 SOL ke vault");
    await program.methods.deposit(new BN(2 * SOL)).rpc();
    const balance = await provider.connection.getBalance(vaultPda);
    assert.isAtLeast(balance, 2 * SOL);
    ok(`Saldo vault: ${lamportsToSol(balance)} SOL`);
    await pause();
  });

  it("creates an agent session", async () => {
    step(3, "Owner delegasikan session key ke AI agent");
    const expiry = Math.floor(Date.now() / 1000) + 3600;
    await program.methods
      .createSession(
        agentKey.publicKey,
        new BN(expiry),
        new BN(0.5 * SOL),
        new BN(1 * SOL),
      )
      .rpc();
    const session = await program.account.session.fetch(sessionPda);
    assert.ok(session.signer.equals(agentKey.publicKey));
    ok("Agent punya session key terbatas — bukan private key owner");
    await pause();
  });

  it("lets the agent transfer within policy", async () => {
    step(4, "Agent transfer 0.1 SOL (dalam batas mandat)");
    const before = await provider.connection.getBalance(stranger.publicKey);
    await program.methods
      .executeTransfer(new BN(0.1 * SOL))
      .accounts({
        sessionSigner: agentKey.publicKey,
        owner,
        vault: vaultPda,
        session: sessionPda,
        destination: stranger.publicKey,
      })
      .signers([agentKey])
      .rpc();
    const after = await provider.connection.getBalance(stranger.publicKey);
    assert.equal(after - before, 0.1 * SOL);
    ok("Transfer berhasil — policy check passed on-chain");
    await pause();
  });

  it("denies a transfer over the per-tx limit", async () => {
    banner("KLIMaks DEMO — Policy ditegakkan on-chain");
    step(5, "Agent mencoba transfer 5 SOL (melebihi limit 0.5 SOL/tx)");
    try {
      await program.methods
        .executeTransfer(new BN(5 * SOL))
        .accounts({
          sessionSigner: agentKey.publicKey,
          owner,
          vault: vaultPda,
          session: sessionPda,
          destination: stranger.publicKey,
        })
        .signers([agentKey])
        .rpc();
      assert.fail("transfer should have been rejected");
    } catch (err: any) {
      expectMandatError(err, "PerTxLimitExceeded", "per-transaction limit");
      fail("PerTxLimitExceeded — transaksi ditolak oleh program Mandat");
    }
    await pause(1500);
  });

  it("kill switch freezes the vault", async () => {
    step(6, "Owner aktifkan kill switch");
    await program.methods.setFrozen(true).rpc();
    ok("Vault dibekukan");
    if (DEMO) console.log("      Agent mencoba transfer 0.01 SOL...");
    try {
      await program.methods
        .executeTransfer(new BN(0.01 * SOL))
        .accounts({
          sessionSigner: agentKey.publicKey,
          owner,
          vault: vaultPda,
          session: sessionPda,
          destination: stranger.publicKey,
        })
        .signers([agentKey])
        .rpc();
      assert.fail("frozen vault should reject transfers");
    } catch (err: any) {
      expectMandatError(err, "VaultFrozen", "Vault is frozen");
      fail("VaultFrozen — semua aktivitas agent dihentikan");
    }
    await program.methods.setFrozen(false).rpc();
    await pause();
  });

  it("owner can withdraw without policy limits", async () => {
    step(7, "Owner withdraw 1 SOL (tanpa batas policy agent)");
    await program.methods
      .withdraw(new BN(1 * SOL))
      .accounts({ destination: owner })
      .rpc();
    ok("Owner tetap punya kontrol penuh atas dana");
    await pause();
  });

  after(async () => {
    if (!DEMO) return;
    console.log("");
    console.log("═".repeat(60));
    console.log("  Demo selesai — 7/7 skenario lulus");
    console.log("  Mandat: beri agent Anda mandat, bukan kunci.");
    console.log("═".repeat(60));
    console.log("");
  });
});
