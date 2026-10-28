import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import { assert } from "chai";
import { Mandat } from "../target/types/mandat";
import { expectMandatError } from "./helpers";

describe("mandat", () => {
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
    perTxLimit: new BN(0.5 * LAMPORTS_PER_SOL),
    dailyLimit: new BN(1 * LAMPORTS_PER_SOL),
    activeHourStart: 0,
    activeHourEnd: 0, // window check disabled
    restrictDestinations: false,
    allowedDestinations: [] as PublicKey[],
  };

  it("initializes a vault with a policy", async () => {
    await program.methods.initializeVault(policy).rpc();
    const vault = await program.account.vault.fetch(vaultPda);
    assert.ok(vault.owner.equals(owner));
    assert.isFalse(vault.frozen);
    assert.ok(vault.policy.dailyLimit.eq(policy.dailyLimit));
  });

  it("accepts deposits", async () => {
    await program.methods.deposit(new BN(2 * LAMPORTS_PER_SOL)).rpc();
    const balance = await provider.connection.getBalance(vaultPda);
    assert.isAtLeast(balance, 2 * LAMPORTS_PER_SOL);
  });

  it("creates an agent session", async () => {
    const expiry = Math.floor(Date.now() / 1000) + 3600;
    await program.methods
      .createSession(
        agentKey.publicKey,
        new BN(expiry),
        new BN(0.5 * LAMPORTS_PER_SOL),
        new BN(1 * LAMPORTS_PER_SOL),
      )
      .rpc();
    const session = await program.account.session.fetch(sessionPda);
    assert.ok(session.signer.equals(agentKey.publicKey));
    assert.isFalse(session.revoked);
  });

  it("lets the agent transfer within policy", async () => {
    const before = await provider.connection.getBalance(stranger.publicKey);
    await program.methods
      .executeTransfer(new BN(0.1 * LAMPORTS_PER_SOL))
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
    assert.equal(after - before, 0.1 * LAMPORTS_PER_SOL);
  });

  it("denies a transfer over the per-tx limit", async () => {
    try {
      await program.methods
        .executeTransfer(new BN(5 * LAMPORTS_PER_SOL))
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
    }
  });

  it("kill switch freezes the vault", async () => {
    await program.methods.setFrozen(true).rpc();
    try {
      await program.methods
        .executeTransfer(new BN(0.01 * LAMPORTS_PER_SOL))
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
    }
    await program.methods.setFrozen(false).rpc();
  });

  it("owner can withdraw without policy limits", async () => {
    await program.methods
      .withdraw(new BN(1 * LAMPORTS_PER_SOL))
      .accounts({ destination: owner })
      .rpc();
  });
});
