import type { FinancialRecoverySettlementSubmitEvidenceBindingResult } from "./financial-recovery-settlement-submit-evidence-binding"

type SettlementSubmitReference = Extract<
  FinancialRecoverySettlementSubmitEvidenceBindingResult,
  { outcome: "UNRESOLVED" }
>["reference"]

type FinancialRecoverySettlementSubmitSequenceClassification = Readonly<
  | {
      authorizesFinancialAction: false
      outcome: "BLOCKED"
      reference: null
      moneyMovementProven: false
    }
  | {
      authorizesFinancialAction: false
      outcome: "PREPARED_IS_NEXT"
      reference: SettlementSubmitReference
      observedSourceSequence: string
      moneyMovementProven: false
    }
  | {
      authorizesFinancialAction: false
      outcome: "SOURCE_AT_OR_PAST_PREPARED"
      reference: SettlementSubmitReference
      observedSourceSequence: string
      moneyMovementProven: false
    }
  | {
      authorizesFinancialAction: false
      outcome: "SOURCE_BEHIND_PREPARED_GAP"
      reference: SettlementSubmitReference
      observedSourceSequence: string
      moneyMovementProven: false
    }
>

function compareDecimalStrings(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1
  if (left === right) return 0
  return left < right ? -1 : 1
}

function incrementDecimalString(value: string): string {
  const digits = value.split("")
  let carry = 1
  for (let index = digits.length - 1; index >= 0 && carry === 1; index -= 1) {
    if (digits[index] === "9") digits[index] = "0"
    else {
      digits[index] = String(Number(digits[index]) + 1)
      carry = 0
    }
  }
  return carry === 1 ? `1${digits.join("")}` : digits.join("")
}

export function classifyFinancialRecoverySettlementSubmitSequence(
  input: FinancialRecoverySettlementSubmitEvidenceBindingResult,
): FinancialRecoverySettlementSubmitSequenceClassification {
  if (input.outcome !== "UNRESOLVED") {
    return {
      authorizesFinancialAction: false,
      outcome: "BLOCKED",
      reference: null,
      moneyMovementProven: false,
    }
  }

  if (!/^[1-9][0-9]*$/.test(input.reference.preparedSequence) || !/^(0|[1-9][0-9]*)$/.test(input.observedSourceSequence)) {
    return {
      authorizesFinancialAction: false,
      outcome: "BLOCKED",
      reference: null,
      moneyMovementProven: false,
    }
  }

  const nextObserved = incrementDecimalString(input.observedSourceSequence)
  const comparison = compareDecimalStrings(input.observedSourceSequence, input.reference.preparedSequence)
  const outcome = nextObserved === input.reference.preparedSequence
    ? "PREPARED_IS_NEXT"
    : comparison >= 0
      ? "SOURCE_AT_OR_PAST_PREPARED"
      : "SOURCE_BEHIND_PREPARED_GAP"

  return {
    authorizesFinancialAction: false,
    outcome,
    reference: input.reference,
    observedSourceSequence: input.observedSourceSequence,
    moneyMovementProven: false,
  }
}

export type { FinancialRecoverySettlementSubmitSequenceClassification }
