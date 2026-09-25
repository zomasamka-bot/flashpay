export const STROOPS_PER_PI = 10_000_000

export function numberToExactPositiveStroops(value: number): number | null {
  if (!Number.isFinite(value) || value <= 0) return null

  // Do not decide stroop exactness by binary floating-point multiplication.
  // Values such as 0.14 are exactly representable at Pi's 7-decimal wire
  // precision, but `0.14 * 10_000_000` can evaluate to 1400000.0000000002.
  // Canonicalize at the protocol precision, then require an exact numeric
  // round-trip so values with real precision beyond 7 decimals still fail closed.
  const canonical = value.toFixed(7)
  if (Number(canonical) !== value) return null
  return stellarAmountToExactPositiveStroops(canonical)
}

export function stellarAmountToExactPositiveStroops(value: unknown): number | null {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,7})?$/.test(value)) return null
  const [whole, fraction = ""] = value.split(".")
  const normalized = `${whole}${fraction.padEnd(7, "0")}`
  if (!/^[0-9]+$/.test(normalized)) return null
  const parsed = Number(normalized)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

export function exactStroopAmountMatch(stellarAmount: unknown, expectedPi: number): boolean {
  const observed = stellarAmountToExactPositiveStroops(stellarAmount)
  const expected = numberToExactPositiveStroops(expectedPi)
  return observed !== null && expected !== null && observed === expected
}

export function exactPositiveStroopsToStellarAmount(stroops: number): string | null {
  if (!Number.isSafeInteger(stroops) || stroops <= 0) return null
  const digits = String(stroops).padStart(8, "0")
  return `${digits.slice(0, -7)}.${digits.slice(-7)}`
}
