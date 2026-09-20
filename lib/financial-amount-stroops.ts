export const STROOPS_PER_PI = 10_000_000

export function numberToExactPositiveStroops(value: number): number | null {
  if (!Number.isFinite(value) || value <= 0) return null
  const scaled = value * STROOPS_PER_PI
  return Number.isSafeInteger(scaled) ? scaled : null
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
