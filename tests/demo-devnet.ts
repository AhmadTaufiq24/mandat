import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { assert } from "chai";
import { Mandat } from "../target/types/mandat";
import { expectMandatError } from "./helpers";

const DEMO = process.env.MANDAT_DEMO === "1";
const SOL = LAMPORTS_PER_SOL;

function explorerTx(signature: string) {
  return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
}

function explorerAddress(address: string) {
  return `https://explorer.solana.com/address/${address}?cluster=devnet`;
}

function logStep(n: number, text: string) {
  console.log(`\n[${n}/7] ${text}`);
}

function logOk(text: string) {
  console.log(`      OK  ${text}`);
}

describe("Mandat — Devnet Demo", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Mandat as Program<Mandat>;
  const owner = provider.wallet.publicKey;

  const agentKey = Keypair.generate();
  const recipient = Keypair.generate();

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
    const balance = await provider.connection.getBalance(owner);
    console.log("");
    console.log("  MANDAT — Devnet Demo");
    console.log(`  Program : ${program.programId.toBase58()}`);
    console.log(`  Explorer: ${explorerAddress(program.programId.toBase58())}`);
    console.log(`  Owner   : ${owner.toBase58()} (${(balance / SOL).toFixed(4)} SOL)`);
    console.log(`  Agent   : ${agentKey.publicKey.toBase58()}`);
    assert.isAtLeast(balance, 0.5 * SOL, "Wallet needs devnet SOL — run: npm run devnet:fund");

    const existing = await provider.connection.getAccountInfo(vaultPda);
    if (existing) {
      const vault = await program.account.vault.fetch(vaultPda);
      if (vault.frozen) {
        await program.methods.setFrozen(false).rpc();
        console.log("  (reset: vault unfrozen from previous run)");
      }
    }
  });

  it("initializes vault on devnet", async () => {
    logStep(1, "Initialize vault + policy");
    const existing = await provider.connection.getAccountInfo(vaultPda);
    if (existing) {
      logOk(`Vault already exists — ${explorerAddress(vaultPda.toBase58())}`);
      return;
    }
    const sig = await program.methods.initializeVault(policy).rpc();
    logOk(`tx: ${explorerTx(sig)}`);
  });

  it("deposits SOL into vault", async () => {
    logStep(2, "Deposit 0.5 SOL");
    const sig = await program.methods.deposit(new BN(0.5 * SOL)).rpc();
    const balance = await provider.connection.getBalance(vaultPda);
    logOk(`${(balance / SOL).toFixed(4)} SOL in vault — ${explorerTx(sig)}`);
  });

  it("creates agent session", async () => {
    logStep(3, "Delegate session key to agent");
    const expiry = Math.floor(Date.now() / 1000) + 86400;
    const sig = await program.methods
      .createSession(
        agentKey.publicKey,
        new BN(expiry),
        new BN(0.5 * SOL),
        new BN(1 * SOL),
      )
      .rpc();
    logOk(explorerTx(sig));
  });

  it("agent transfer within policy", async () => {
    logStep(4, "Agent transfer 0.05 SOL");
    const sig = await program.methods
      .executeTransfer(new BN(0.05 * SOL))
      .accounts({
        sessionSigner: agentKey.publicKey,
        owner,
        vault: vaultPda,
        session: sessionPda,
        destination: recipient.publicKey,
      })
      .signers([agentKey])
      .rpc();
    logOk(explorerTx(sig));
  });

  it("rejects over-limit transfer", async () => {
    logStep(5, "Agent tries 2 SOL transfer (should fail)");
    try {
      await program.methods
        .executeTransfer(new BN(2 * SOL))
        .accounts({
          sessionSigner: agentKey.publicKey,
          owner,
          vault: vaultPda,
          session: sessionPda,
          destination: recipient.publicKey,
        })
        .signers([agentKey])
        .rpc();
      assert.fail("expected PerTxLimitExceeded");
    } catch (err: any) {
      expectMandatError(err, "PerTxLimitExceeded", "per-transaction limit");
      logOk("PerTxLimitExceeded — blocked on-chain");
    }
  });

  it("kill switch blocks agent", async () => {
    logStep(6, "Owner activates kill switch");
    await program.methods.setFrozen(true).rpc();
    try {
      try {
        await program.methods
          .executeTransfer(new BN(0.01 * SOL))
          .accounts({
            sessionSigner: agentKey.publicKey,
            owner,
            vault: vaultPda,
            session: sessionPda,
            destination: recipient.publicKey,
          })
          .signers([agentKey])
          .rpc();
        assert.fail("expected VaultFrozen");
      } catch (err: any) {
        expectMandatError(err, "VaultFrozen", "Vault is frozen");
        logOk("VaultFrozen — agent stopped");
      }
    } finally {
      await program.methods.setFrozen(false).rpc();
    }
  });

  it("owner withdraws freely", async () => {
    logStep(7, "Owner withdraw 0.1 SOL");
    const sig = await program.methods
      .withdraw(new BN(0.1 * SOL))
      .accounts({ destination: owner })
      .rpc();
    logOk(explorerTx(sig));
    console.log("");
    console.log(`  Vault explorer: ${explorerAddress(vaultPda.toBase58())}`);
    console.log("  Devnet demo complete.");
    console.log("");
  });
});
