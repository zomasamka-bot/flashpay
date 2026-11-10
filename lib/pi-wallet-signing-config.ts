import "server-only"
import { Keypair } from "@stellar/stellar-sdk"

/** Only the explicitly pinned active wallet can sign. Missing, invalid or
 * mismatched configuration fails closed; there is no legacy-key fallback.
 * Original per-payment source-address guards remain authoritative.
 */
export function getPiSigningSeed(): string | undefined {
  const active = process.env.PI_ACTIVE_PRIVATE_SEED
  const expected = process.env.PI_ACTIVE_WALLET_ADDRESS
  if (!active || !expected || !/^G[A-Z2-7]{55}$/.test(expected)) return undefined
  try {
    return Keypair.fromSecret(active).publicKey() === expected ? active : undefined
  } catch {
    return undefined
  }
}
