import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
} from "@solana/web3.js";
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

  before(async () => {
    // Proof of where this suite runs: must be the local test validator.
    const genesis = await provider.connection.getGenesisHash();
    console.log(`      RPC endpoint: ${provider.connection.rpcEndpoint}`);
    console.log(`      Genesis hash: ${genesis}`);
    assert.match(
      provider.connection.rpcEndpoint,
      /^http:\/\/(127\.0\.0\.1|localhost):8899/,
      "mandat tests must run against localnet only",
    );
  });

  it("initializes a vault with a policy", async () => {
    // Other suites in tests/ (demo.ts, demo-devnet.ts) share this owner's
    // vault PDA, so reuse it if it already exists.
    const existing = await provider.connection.getAccountInfo(vaultPda);
    if (existing) {
      await program.methods.updatePolicy(policy).rpc();
      await program.methods.setFrozen(false).rpc();
    } else {
      await program.methods.initializeVault(policy).rpc();
    }
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

  // -------------------------------------------------------------------------
  // Policy enforcement, session lifecycle and access control
  // -------------------------------------------------------------------------

  const SOL = LAMPORTS_PER_SOL;
  const sol = (n: number) => new BN(Math.round(n * SOL));

  /** Permissive policy used between tests (daily limit far above usage). */
  const openPolicy = {
    perTxLimit: sol(1),
    dailyLimit: sol(1000),
    activeHourStart: 0,
    activeHourEnd: 0,
    restrictDestinations: false,
    allowedDestinations: [] as PublicKey[],
  };

  const sessionFor = (signer: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("session"), vaultPda.toBuffer(), signer.toBuffer()],
      program.programId,
    )[0];

  /** On-chain unix timestamp from the Clock sysvar. */
  async function chainNow(): Promise<number> {
    const info = await provider.connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY);
    // Clock layout: slot u64, epoch_start_timestamp i64, epoch u64,
    // leader_schedule_epoch u64, unix_timestamp i64.
    return Number(info!.data.readBigInt64LE(32));
  }

  async function spentToday(): Promise<BN> {
    return (await program.account.vault.fetch(vaultPda)).policy.spentToday;
  }

  async function setPolicy(p: typeof openPolicy) {
    await program.methods.updatePolicy(p).rpc();
  }

  async function newSession(
    signer: Keypair,
    perTx: number,
    daily: number,
    ttlSeconds = 3600,
  ) {
    const expiry = (await chainNow()) + ttlSeconds;
    await program.methods
      .createSession(signer.publicKey, new BN(expiry), sol(perTx), sol(daily))
      .rpc();
    return sessionFor(signer.publicKey);
  }

  function transfer(
    signer: Keypair,
    lamports: BN,
    destination: PublicKey,
    session: PublicKey = sessionFor(signer.publicKey),
  ) {
    return program.methods
      .executeTransfer(lamports)
      .accountsPartial({
        sessionSigner: signer.publicKey,
        owner,
        vault: vaultPda,
        session,
        destination,
      })
      .signers([signer])
      .rpc();
  }

  async function expectFail(p: Promise<unknown>, ...needles: string[]) {
    try {
      await p;
    } catch (err: any) {
      expectMandatError(err, ...needles);
      return;
    }
    assert.fail(`expected failure with one of [${needles.join(", ")}]`);
  }

  const recipient = Keypair.generate().publicKey;

  describe("policy & session coverage", () => {
    before(async () => {
      await program.methods.deposit(sol(5)).rpc();
      await setPolicy(openPolicy);
    });

    afterEach(async () => {
      await setPolicy(openPolicy);
      const v = await program.account.vault.fetch(vaultPda);
      if (v.frozen) await program.methods.setFrozen(false).rpc();
    });

    after(async () => {
      // Leave the vault with the suite's original policy.
      await setPolicy(policy);
    });

    it("enforces the vault-wide daily limit across several transfers", async () => {
      const agent = Keypair.generate();
      await newSession(agent, 1, 100); // session limits out of the way
      // Make sure the vault day counter is on today's day.
      await transfer(agent, sol(0.01), recipient);
      const base = await spentToday();
      await setPolicy({
        ...openPolicy,
        perTxLimit: sol(0.2),
        dailyLimit: base.add(sol(0.3)),
      });
      await transfer(agent, sol(0.15), recipient);
      await transfer(agent, sol(0.15), recipient); // exactly at the limit
      await expectFail(
        transfer(agent, sol(0.01), recipient),
        "DailyLimitExceeded",
        "daily limit",
      );
      assert.ok((await spentToday()).eq(base.add(sol(0.3))));
    });

    it("enforces the per-session daily limit", async () => {
      const agent = Keypair.generate();
      const session = await newSession(agent, 0.15, 0.2);
      await transfer(agent, sol(0.1), recipient);
      await transfer(agent, sol(0.1), recipient); // exactly at session limit
      await expectFail(
        transfer(agent, sol(0.05), recipient),
        "DailyLimitExceeded",
        "daily limit",
      );
      const s = await program.account.session.fetch(session);
      assert.ok(s.spentToday.eq(sol(0.2)));
    });

    it("enforces the destination whitelist", async () => {
      const agent = Keypair.generate();
      await newSession(agent, 1, 10);
      const allowed = Keypair.generate().publicKey;
      await setPolicy({
        ...openPolicy,
        restrictDestinations: true,
        allowedDestinations: [allowed],
      });
      await expectFail(
        transfer(agent, sol(0.01), recipient),
        "DestinationNotAllowed",
        "not on the policy whitelist",
      );
      const before = await provider.connection.getBalance(allowed);
      await transfer(agent, sol(0.01), allowed);
      const after = await provider.connection.getBalance(allowed);
      assert.equal(after - before, 0.01 * SOL);
    });

    it("rejects transfers outside active hours", async () => {
      const agent = Keypair.generate();
      await newSession(agent, 1, 10);
      const hour = Math.floor(((await chainNow()) % 86400) / 3600);
      // A 2-hour window starting 2h from now never contains the current hour.
      await setPolicy({
        ...openPolicy,
        activeHourStart: (hour + 2) % 24,
        activeHourEnd: (hour + 4) % 24,
      });
      await expectFail(
        transfer(agent, sol(0.01), recipient),
        "OutsideActiveHours",
        "active hours",
      );
    });

    it("rejects transfers on a revoked session", async () => {
      const agent = Keypair.generate();
      const session = await newSession(agent, 1, 10);
      await transfer(agent, sol(0.01), recipient);
      await program.methods.revokeSession().accountsPartial({ session }).rpc();
      assert.isTrue((await program.account.session.fetch(session)).revoked);
      await expectFail(
        transfer(agent, sol(0.01), recipient),
        "SessionRevoked",
        "Session has been revoked",
      );
    });

    it("rejects transfers on an expired session", async () => {
      const agent = Keypair.generate();
      const session = await newSession(agent, 1, 10, 3);
      const { expiresAt } = await program.account.session.fetch(session);
      const deadline = Date.now() + 60_000;
      while ((await chainNow()) < expiresAt.toNumber()) {
        assert.isBelow(Date.now(), deadline, "validator clock did not advance");
        await new Promise((r) => setTimeout(r, 500));
      }
      await expectFail(
        transfer(agent, sol(0.01), recipient),
        "SessionExpired",
        "Session has expired",
      );
    });

    it("rejects create_session with an expiry in the past", async () => {
      const agent = Keypair.generate();
      const past = (await chainNow()) - 60;
      await expectFail(
        program.methods
          .createSession(agent.publicKey, new BN(past), sol(0.1), sol(1))
          .rpc(),
        "SessionExpiryInPast",
        "expiry must be in the future",
      );
      assert.isNull(
        await provider.connection.getAccountInfo(sessionFor(agent.publicKey)),
      );
    });

    it("rejects create_session with an expiry beyond 30 days (F-08)", async () => {
      const agent = Keypair.generate();
      const tooFar = (await chainNow()) + 31 * 86400;
      await expectFail(
        program.methods
          .createSession(agent.publicKey, new BN(tooFar), sol(0.1), sol(1))
          .rpc(),
        "InvalidSession",
        "Invalid session parameters",
      );
      assert.isNull(
        await provider.connection.getAccountInfo(sessionFor(agent.publicKey)),
      );
    });

    it("rejects create_session with per_tx_limit > daily_limit (F-08)", async () => {
      const agent = Keypair.generate();
      const expiry = (await chainNow()) + 3600;
      await expectFail(
        program.methods
          .createSession(agent.publicKey, new BN(expiry), sol(2), sol(1))
          .rpc(),
        "InvalidSession",
        "Invalid session parameters",
      );
      assert.isNull(
        await provider.connection.getAccountInfo(sessionFor(agent.publicKey)),
      );
    });

    it("accepts a session expiring in ~29 days (F-08 upper bound)", async () => {
      const agent = Keypair.generate();
      const session = await newSession(agent, 0.1, 1, 29 * 86400);
      const s = await program.account.session.fetch(session);
      assert.isAbove(s.expiresAt.toNumber(), (await chainNow()) + 28 * 86400);
      await transfer(agent, sol(0.01), recipient);
      await program.methods.closeSession().accountsPartial({ session }).rpc();
    });

    it("rejects a stranger signing with someone else's session PDA", async () => {
      const agent = Keypair.generate();
      const session = await newSession(agent, 1, 10);
      const thief = Keypair.generate();
      const vaultBefore = await provider.connection.getBalance(vaultPda);
      await expectFail(
        transfer(thief, sol(0.01), thief.publicKey, session),
        "ConstraintSeeds",
        "Unauthorized",
        "A seeds constraint was violated",
      );
      assert.equal(await provider.connection.getBalance(vaultPda), vaultBefore);
    });

    it("rejects update_policy and set_frozen from a non-owner", async () => {
      const intruder = Keypair.generate();
      const before = await program.account.vault.fetch(vaultPda);
      await expectFail(
        program.methods
          .updatePolicy({ ...openPolicy, dailyLimit: sol(1_000_000) })
          .accountsPartial({ owner: intruder.publicKey, vault: vaultPda })
          .signers([intruder])
          .rpc(),
        "ConstraintSeeds",
        "ConstraintHasOne",
        "Unauthorized",
      );
      await expectFail(
        program.methods
          .setFrozen(true)
          .accountsPartial({ owner: intruder.publicKey, vault: vaultPda })
          .signers([intruder])
          .rpc(),
        "ConstraintSeeds",
        "ConstraintHasOne",
        "Unauthorized",
      );
      // Intruder's own (non-existent) vault PDA cannot be used either.
      await expectFail(
        program.methods
          .setFrozen(true)
          .accounts({ owner: intruder.publicKey })
          .signers([intruder])
          .rpc(),
        "AccountNotInitialized",
        "ConstraintSeeds",
      );
      const after = await program.account.vault.fetch(vaultPda);
      assert.isFalse(after.frozen);
      assert.ok(after.policy.dailyLimit.eq(before.policy.dailyLimit));
    });

    it("update_policy preserves spent_today (regression)", async () => {
      const agent = Keypair.generate();
      await newSession(agent, 1, 100);
      await transfer(agent, sol(0.01), recipient); // day counter = today
      const base = await spentToday();
      const tight = {
        ...openPolicy,
        perTxLimit: sol(0.2),
        dailyLimit: base.add(sol(0.2)),
      };
      await setPolicy(tight);
      await transfer(agent, sol(0.15), recipient);
      const spent = await spentToday();
      const { lastDay } = (await program.account.vault.fetch(vaultPda)).policy;
      assert.ok(spent.eq(base.add(sol(0.15))));

      // Owner updates the policy mid-day (same limits).
      await setPolicy(tight);
      const v = await program.account.vault.fetch(vaultPda);
      assert.ok(v.policy.spentToday.eq(spent), "spent_today was reset");
      assert.ok(v.policy.lastDay.eq(lastDay), "last_day was reset");

      // The limit still binds: only 0.05 SOL of headroom is left.
      await expectFail(
        transfer(agent, sol(0.1), recipient),
        "DailyLimitExceeded",
        "daily limit",
      );
      await transfer(agent, sol(0.05), recipient);
    });

    it("close_session returns rent to the owner and allows re-creating the session", async () => {
      const agent = Keypair.generate();
      const session = await newSession(agent, 1, 10);
      await program.methods.revokeSession().accountsPartial({ session }).rpc();

      // A stranger cannot close it.
      const intruder = Keypair.generate();
      await expectFail(
        program.methods
          .closeSession()
          .accountsPartial({ owner: intruder.publicKey, vault: vaultPda, session })
          .signers([intruder])
          .rpc(),
        "ConstraintSeeds",
        "ConstraintHasOne",
        "Unauthorized",
      );

      const rent = await provider.connection.getBalance(session);
      assert.isAbove(rent, 0);
      const ownerBefore = await provider.connection.getBalance(owner);
      const sig = await program.methods
        .closeSession()
        .accountsPartial({ session })
        .rpc();
      let tx = null;
      for (let i = 0; i < 60 && !tx; i++) {
        tx = await provider.connection.getTransaction(sig, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        });
        if (!tx) await new Promise((r) => setTimeout(r, 250));
      }
      assert.ok(tx, "close_session transaction not found");
      const meta = tx!.meta!;
      const keys = tx!.transaction.message.getAccountKeys().staticAccountKeys;
      const ownerIdx = keys.findIndex((k) => k.equals(owner));
      const sessionIdx = keys.findIndex((k) => k.equals(session));
      const ownerDelta = meta.postBalances[ownerIdx] - meta.preBalances[ownerIdx];
      const ownerAfter = await provider.connection.getBalance(owner);
      console.log(
        `      rent=${rent} fee=${meta.fee} ownerDelta(tx)=${ownerDelta} ` +
          `ownerDelta(getBalance)=${ownerAfter - ownerBefore}`,
      );
      // Session lamports (small numbers, exact): all of the rent leaves it.
      assert.equal(meta.preBalances[sessionIdx], rent);
      assert.equal(meta.postBalances[sessionIdx], 0);
      // The localnet wallet holds ~5e17 lamports, beyond Number's 2^53 exact
      // range (1 ulp = 64 lamports there), so compare the owner's delta with
      // a small tolerance: owner receives the rent minus the tx fee.
      assert.approximately(ownerDelta, rent - meta.fee, 128);
      assert.approximately(ownerAfter - ownerBefore, rent - meta.fee, 128);
      assert.isNull(await provider.connection.getAccountInfo(session));

      // SessionClosed event emitted.
      const parser = new anchor.EventParser(program.programId, program.coder);
      const events = [...parser.parseLogs(tx!.meta!.logMessages ?? [])];
      const closed = events.find((e) => e.name.toLowerCase() === "sessionclosed");
      assert.ok(closed, "SessionClosed event not found");
      assert.ok(closed!.data.session.equals(session));
      assert.ok(closed!.data.vault.equals(vaultPda));

      // Same signer can get a fresh session, and it works.
      const again = await newSession(agent, 1, 10);
      assert.ok(again.equals(session));
      const s = await program.account.session.fetch(again);
      assert.isFalse(s.revoked);
      assert.ok(s.spentToday.eqn(0));
      await transfer(agent, sol(0.01), recipient);

      // Owner can also close a live (non-revoked) session.
      await program.methods.closeSession().accountsPartial({ session: again }).rpc();
      assert.isNull(await provider.connection.getAccountInfo(again));
    });
  });
});
