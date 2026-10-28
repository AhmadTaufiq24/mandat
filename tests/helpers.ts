import { assert } from "chai";

/** Match Anchor error by enum name (localnet) or human msg (devnet/web3.js). */
export function expectMandatError(err: unknown, ...needles: string[]) {
  const msg = String(err);
  const hit = needles.some((n) => msg.includes(n));
  assert.isTrue(
    hit,
    `expected one of [${needles.join(", ")}] in error: ${msg}`,
  );
}
