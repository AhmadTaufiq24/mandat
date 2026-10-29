import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createMint,
  createAccount,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { assert } from "chai";
import { Mandat } from "../target/types/mandat";
import { expectMandatError } from "./helpers";

// SPL token path (x402 / USDC-style). Shares the owner's vault PDA with the
// other suites, so it reads and restores the SOL policy it touches.
describe("mandat token path", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Mandat as Program<Mandat>;
  const owner = provider.wallet.publicKey;
  const payer = (provider.wallet as any).payer as Keypair;
  const conn = provider.connection;

  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), owner.toBuffer()],
    program.programId,
  );
  const sessionFor = (signer: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("session"), vaultPda.toBuffer(), signer.toBuffer()],
      program.programId,
    )[0];

  const U = 1_000_000; // 6 decimals, like USDC
  const agent = Keypair.generate();
  const recipient = Keypair.generate().publicKey;
  const other = Keypair.generate().publicKey;
  let mint: PublicKey;
  let mint2: PublicKey;
  let vaultAta: PublicKey;
  let recipientAta: PublicKey;
  let otherAta: PublicKey;

  async function chainNow(): Promise<number> {
    const info = await conn.getAccountInfo(SYSVAR_CLOCK_PUBKEY);
    return Number(info!.data.readBigInt64LE(32));
  }
  const bal = async (a: PublicKey) => Number((await getAccount(conn, a)).amount);

  async function expectFail(p: Promise<unknown>, ...needles: string[]) {
    try {
      await p;
    } catch (err: any) {
      expectMandatError(err, ...needles);
      return;
    }
    assert.fail(`expected failure with one of [${needles.join(", ")}]`);
  }

  function tokenTransfer(
    amount: number,
    o: {
      signer?: Keypair;
      session?: PublicKey;
      mint?: PublicKey;
      source?: PublicKey;
      destination?: PublicKey;
      tokenProgram?: PublicKey;
    } = {},
  ) {
    const signer = o.signer ?? agent;
    return program.methods
      .executeTokenTransfer(new BN(amount))
      .accountsPartial({
        sessionSigner: signer.publicKey,
        owner,
        vault: vaultPda,
        session: o.session ?? sessionFor(signer.publicKey),
        mint: o.mint ?? mint,
        source: o.source ?? vaultAta,
        destination: o.destination ?? recipientAta,
        tokenProgram: o.tokenProgram ?? TOKEN_PROGRAM_ID,
      })
      .signers([signer])
      .rpc();
  }

  async function newSession(signer: Keypair, tokPerTx: number, tokDaily: number) {
    const expiry = (await chainNow()) + 3600;
    await program.methods
      .createSession(signer.publicKey, new BN(expiry), new BN(1e9), new BN(1e9))
      .rpc();
    const session = sessionFor(signer.publicKey);
    if (tokDaily > 0) {
      await program.methods
        .setSessionTokenLimits(new BN(tokPerTx), new BN(tokDaily))
        .accountsPartial({ session })
        .rpc();
    }
    return session;
  }

  /** Current SOL policy as PolicyArgs, so tests can tweak and restore it. */
  async function currentPolicyArgs() {
    const p = (await program.account.vault.fetch(vaultPda)).policy;
    return {
      perTxLimit: p.perTxLimit,
      dailyLimit: p.dailyLimit,
      activeHourStart: p.activeHourStart,
      activeHourEnd: p.activeHourEnd,
      restrictDestinations: p.restrictDestinations,
      allowedDestinations: p.allowedDestinations,
    };
  }

  before(async () => {
    assert.match(conn.rpcEndpoint, /^http:\/\/(127\.0\.0\.1|localhost):8899/);
    if (!(await conn.getAccountInfo(vaultPda))) {
      await program.methods
        .initializeVault({
          perTxLimit: new BN(5e8),
          dailyLimit: new BN(1e9),
          activeHourStart: 0,
          activeHourEnd: 0,
          restrictDestinations: false,
          allowedDestinations: [],
        })
        .rpc();
    }
    const v = await program.account.vault.fetch(vaultPda);
    if (v.frozen) await program.methods.setFrozen(false).rpc();

    mint = await createMint(conn, payer, owner, null, 6);
    mint2 = await createMint(conn, payer, owner, null, 6);
    vaultAta = (await getOrCreateAssociatedTokenAccount(conn, payer, mint, vaultPda, true)).address;
    recipientAta = (await getOrCreateAssociatedTokenAccount(conn, payer, mint, recipient)).address;
    otherAta = (await getOrCreateAssociatedTokenAccount(conn, payer, mint, other)).address;
    await mintTo(conn, payer, mint, vaultAta, payer, 1000 * U);
    await newSession(agent, 5 * U, 8 * U);
  });

  it("rejects token transfers before the token policy is configured", async () => {
    await expectFail(
      tokenTransfer(1 * U),
      "MintNotAllowed",
      "TokenPolicyNotConfigured",
    );
  });

  it("only the owner can configure the token policy / session token limits", async () => {
    const intruder = Keypair.generate();
    await expectFail(
      program.methods
        .configureTokenPolicy(new BN(10 * U), new BN(20 * U))
        .accountsPartial({ owner: intruder.publicKey, vault: vaultPda, mint })
        .signers([intruder])
        .rpc(),
      "ConstraintSeeds",
      "Unauthorized",
    );
    await expectFail(
      program.methods
        .setSessionTokenLimits(new BN(1000 * U), new BN(1000 * U))
        .accountsPartial({
          owner: intruder.publicKey,
          vault: vaultPda,
          session: sessionFor(agent.publicKey),
        })
        .signers([intruder])
        .rpc(),
      "ConstraintSeeds",
      "Unauthorized",
    );
  });

  it("configures the token policy and transfers within limits (separate counters)", async () => {
    await program.methods
      .configureTokenPolicy(new BN(10 * U), new BN(20 * U))
      .accountsPartial({ mint })
      .rpc();
    const before = await program.account.vault.fetch(vaultPda);
    const r0 = await bal(recipientAta);
    await tokenTransfer(2 * U);
    assert.equal((await bal(recipientAta)) - r0, 2 * U);
    const after = await program.account.vault.fetch(vaultPda);
    assert.ok(after.tokenPolicy.mint.equals(mint));
    assert.equal(
      after.tokenPolicy.spentToday.sub(before.tokenPolicy.spentToday).toNumber(),
      2 * U,
    );
    // SOL counter untouched by the token path.
    assert.ok(after.policy.spentToday.eq(before.policy.spentToday));
    const s = await program.account.session.fetch(sessionFor(agent.publicKey));
    assert.equal(s.tokenSpentToday.toNumber(), 2 * U);
    assert.equal(s.spentToday.toNumber(), 0);
  });

  it("enforces the session token per-tx limit", async () => {
    await expectFail(tokenTransfer(6 * U), "PerTxLimitExceeded", "per-transaction limit");
  });

  it("enforces the session token daily limit", async () => {
    await tokenTransfer(5 * U); // 7 of 8
    await expectFail(tokenTransfer(2 * U), "DailyLimitExceeded", "daily limit");
  });

  it("a session without token limits cannot use the token path", async () => {
    const a = Keypair.generate();
    await newSession(a, 0, 0);
    await expectFail(tokenTransfer(1, { signer: a }), "PerTxLimitExceeded");
  });

  it("enforces the vault-wide token daily limit (and keeps spend on reconfigure)", async () => {
    const a = Keypair.generate();
    await newSession(a, 10 * U, 100 * U);
    const spent = (await program.account.vault.fetch(vaultPda)).tokenPolicy.spentToday.toNumber();
    try {
      // Same mint: reconfiguring keeps today's spend.
      await program.methods
        .configureTokenPolicy(new BN(3 * U), new BN(spent + 2 * U))
        .accountsPartial({ mint })
        .rpc();
      const v = await program.account.vault.fetch(vaultPda);
      assert.equal(v.tokenPolicy.spentToday.toNumber(), spent);
      await expectFail(tokenTransfer(3 * U, { signer: a }), "DailyLimitExceeded");
      await tokenTransfer(2 * U, { signer: a });
    } finally {
      await program.methods
        .configureTokenPolicy(new BN(10 * U), new BN(1000 * U))
        .accountsPartial({ mint })
        .rpc();
    }
  });

  it("rejects a mint other than the configured one", async () => {
    const a = Keypair.generate();
    await newSession(a, 10 * U, 100 * U);
    const src2 = (await getOrCreateAssociatedTokenAccount(conn, payer, mint2, vaultPda, true)).address;
    const dst2 = (await getOrCreateAssociatedTokenAccount(conn, payer, mint2, recipient)).address;
    await mintTo(conn, payer, mint2, src2, payer, 10 * U);
    await expectFail(
      tokenTransfer(1 * U, { signer: a, mint: mint2, source: src2, destination: dst2 }),
      "MintNotAllowed",
    );
    // Right mint, but a destination account of another mint.
    await expectFail(
      tokenTransfer(1 * U, { signer: a, destination: dst2 }),
      "ConstraintTokenMint",
      "2014",
    );
  });

  it("rejects a wrong token program", async () => {
    const a = Keypair.generate();
    await newSession(a, 10 * U, 100 * U);
    await expectFail(
      tokenTransfer(1 * U, { signer: a, tokenProgram: TOKEN_2022_PROGRAM_ID }),
      "InvalidProgramId",
      "ConstraintMintTokenProgram",
      "AccountOwnedByWrongProgram",
    );
    await expectFail(
      tokenTransfer(1 * U, { signer: a, tokenProgram: SystemProgram.programId }),
      "InvalidProgramId",
    );
  });

  it("rejects Token-2022 (program and mint)", async () => {
    const a = Keypair.generate();
    await newSession(a, 10 * U, 100 * U);
    const mint22 = await createMint(conn, payer, owner, null, 6, Keypair.generate(), undefined, TOKEN_2022_PROGRAM_ID);
    const src22 = (await getOrCreateAssociatedTokenAccount(
      conn, payer, mint22, vaultPda, true, undefined, undefined, TOKEN_2022_PROGRAM_ID,
    )).address;
    const dst22 = (await getOrCreateAssociatedTokenAccount(
      conn, payer, mint22, recipient, false, undefined, undefined, TOKEN_2022_PROGRAM_ID,
    )).address;
    await mintTo(conn, payer, mint22, src22, payer, 10 * U, [], undefined, TOKEN_2022_PROGRAM_ID);
    const v0 = Number((await getAccount(conn, src22, undefined, TOKEN_2022_PROGRAM_ID)).amount);
    // Fully consistent Token-2022 set of accounts + Token-2022 program.
    await expectFail(
      tokenTransfer(1 * U, {
        signer: a, mint: mint22, source: src22, destination: dst22,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      }),
      "InvalidProgramId", "AccountOwnedByWrongProgram", "MintNotAllowed",
    );
    // Token-2022 accounts with the classic program ID.
    await expectFail(
      tokenTransfer(1 * U, { signer: a, mint: mint22, source: src22, destination: dst22 }),
      "AccountOwnedByWrongProgram", "MintNotAllowed",
    );
    // Owner cannot even configure a Token-2022 mint as the allowed mint.
    await expectFail(
      program.methods
        .configureTokenPolicy(new BN(1 * U), new BN(2 * U))
        .accountsPartial({ mint: mint22 })
        .rpc(),
      "AccountOwnedByWrongProgram",
    );
    assert.equal(
      Number((await getAccount(conn, src22, undefined, TOKEN_2022_PROGRAM_ID)).amount),
      v0,
    );
  });

  it("rejects a source token account the vault does not own", async () => {
    const a = Keypair.generate();
    await newSession(a, 10 * U, 100 * U);
    // owner-held ATA with funds: vault is not its authority.
    const foreign = (await getOrCreateAssociatedTokenAccount(conn, payer, mint, owner)).address;
    await mintTo(conn, payer, mint, foreign, payer, 5 * U);
    await expectFail(
      tokenTransfer(1 * U, { signer: a, source: foreign }),
      "ConstraintTokenOwner",
      "2015",
    );
  });

  it("rejects paying a vault-owned token account", async () => {
    const a = Keypair.generate();
    await newSession(a, 10 * U, 100 * U);
    const vaultSecond = await createAccount(conn, payer, mint, vaultPda, Keypair.generate());
    await expectFail(
      tokenTransfer(1 * U, { signer: a, destination: vaultSecond }),
      "DestinationNotAllowed",
    );
    await expectFail(
      tokenTransfer(1 * U, { signer: a, destination: vaultAta }),
      "DestinationNotAllowed",
      "ConstraintDuplicateMutableAccount",
    );
  });

  it("whitelist is checked against the destination token account's owner", async () => {
    const a = Keypair.generate();
    await newSession(a, 10 * U, 100 * U);
    const saved = await currentPolicyArgs();
    try {
      await program.methods
        .updatePolicy({ ...saved, restrictDestinations: true, allowedDestinations: [recipient] })
        .rpc();
      await expectFail(
        tokenTransfer(1 * U, { signer: a, destination: otherAta }),
        "DestinationNotAllowed",
      );
      const r0 = await bal(recipientAta);
      await tokenTransfer(1 * U, { signer: a, destination: recipientAta });
      assert.equal((await bal(recipientAta)) - r0, 1 * U);
      // Whitelisting the ATA address itself does not authorize it.
      await program.methods
        .updatePolicy({ ...saved, restrictDestinations: true, allowedDestinations: [recipientAta] })
        .rpc();
      await expectFail(
        tokenTransfer(1 * U, { signer: a, destination: recipientAta }),
        "DestinationNotAllowed",
      );
    } finally {
      await program.methods.updatePolicy(saved).rpc();
    }
  });

  it("kill switch and revoke also block the token path", async () => {
    const a = Keypair.generate();
    const session = await newSession(a, 10 * U, 100 * U);
    await program.methods.setFrozen(true).rpc();
    try {
      await expectFail(tokenTransfer(1 * U, { signer: a }), "VaultFrozen");
    } finally {
      await program.methods.setFrozen(false).rpc();
    }
    await program.methods.revokeSession().accountsPartial({ session }).rpc();
    await expectFail(tokenTransfer(1 * U, { signer: a }), "SessionRevoked");
  });

  it("a stranger cannot use someone else's session for tokens", async () => {
    const thief = Keypair.generate();
    const thiefAta = (await getOrCreateAssociatedTokenAccount(conn, payer, mint, thief.publicKey)).address;
    const v0 = await bal(vaultAta);
    await expectFail(
      tokenTransfer(1 * U, {
        signer: thief,
        session: sessionFor(agent.publicKey),
        destination: thiefAta,
      }),
      "ConstraintSeeds",
      "Unauthorized",
    );
    assert.equal(await bal(vaultAta), v0);
  });

  it("owner can withdraw tokens; a non-owner cannot", async () => {
    const ownerAta = (await getOrCreateAssociatedTokenAccount(conn, payer, mint, owner)).address;
    const o0 = await bal(ownerAta);
    await program.methods
      .withdrawToken(new BN(10 * U))
      .accountsPartial({ mint, source: vaultAta, destination: ownerAta, tokenProgram: TOKEN_PROGRAM_ID })
      .rpc();
    assert.equal((await bal(ownerAta)) - o0, 10 * U);
    const intruder = Keypair.generate();
    await expectFail(
      program.methods
        .withdrawToken(new BN(1 * U))
        .accountsPartial({
          owner: intruder.publicKey,
          vault: vaultPda,
          mint,
          source: vaultAta,
          destination: otherAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([intruder])
        .rpc(),
      "ConstraintSeeds",
      "Unauthorized",
    );
  });
});
