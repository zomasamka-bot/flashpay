import "server-only"

import { getRefundCheckpointReadOnly } from "./refund-checkpoint-store"
import type { RefundCheckpointReadOnly } from "./refund-checkpoint-store"
import { readRefundPresentationBlockchain } from "./refund-presentation-blockchain"
import {
  readRefundPresentationPersistence,
  readRefundPresentationPersistences,
  readRefundPresentationProof,
  readRefundPresentationProofs,
  recordRefundPresentationProof,
} from "./refund-presentation-persistence"
import {
  buildRefundPresentationFromEvidence,
  deriveRefundFinalizationFromPersistence,
} from "./refund-presentation"
import type {
  RefundCheckpoint,
  RefundPresentationBlockchainReadResult,
  RefundPresentationPersistenceReadResult,
  RefundPresentationProofReadResult,
  RefundPresentationReadResult,
} from "./types"

export async function readRefundPresentation(refundId: string, suppliedCheckpoint?: RefundCheckpoint, suppliedProof?: { refundId: string; paymentId: string; idempotencyKey: string; result: RefundPresentationProofReadResult }, suppliedPersistence?: { refundId: string; paymentId: string; idempotencyKey: string; result: RefundPresentationPersistenceReadResult }): Promise<RefundPresentationReadResult> {
  try {
    if (suppliedCheckpoint && suppliedCheckpoint.refundId !== refundId) return { outcome: "INDETERMINATE" }
    const checkpointResult: RefundCheckpointReadOnly = suppliedCheckpoint && suppliedCheckpoint.stage === "audit_recorded" && suppliedCheckpoint.status === "completed"
      ? { state: "present", checkpoint: suppliedCheckpoint }
      : await getRefundCheckpointReadOnly(refundId)
    if (checkpointResult.state === "absent") return { outcome: "NOT_FOUND" }
    if (checkpointResult.state === "uncertain") return { outcome: "INDETERMINATE" }

    const checkpoint = checkpointResult.checkpoint

    // PRE-DR118 UX15: a durable pre-confirmation checkpoint is itself sufficient
    // authority to present a non-final refund as pending. Do not require audit,
    // accounting, completion, or projection-finalization evidence before those
    // stages can exist. Contradictory identifiers/states remain fail-closed via
    // the blockchain reader. Final/confirmed presentation still uses the strict
    // persistence/proof path below.
    if (
      checkpoint.stage === "eligibility_verified" ||
      checkpoint.stage === "intent_created" ||
      checkpoint.stage === "wallet_submission_started"
    ) {
      if (checkpoint.status !== "pending") return { outcome: "INDETERMINATE" }
      if (suppliedProof || suppliedPersistence) return { outcome: "INDETERMINATE" }
      const blockchain = await readRefundPresentationBlockchain(checkpoint)
      if (blockchain.outcome !== "PENDING") return { outcome: "INDETERMINATE" }
      const presentation = buildRefundPresentationFromEvidence(checkpoint, {
        requestedAt: checkpoint.createdAt,
        finalization: {
          accountingRecorded: false,
          accountingRecordedAt: null,
          auditRecorded: false,
          auditRecordedAt: null,
          completionAuditRecorded: false,
          completedAt: null,
          projectionFinalized: false,
          finalizedAt: null,
        },
        blockchain: {
          confirmed: false,
          network: null,
          confirmationRecordedAt: null,
          transactionAt: null,
          piTransactionVerified: null,
          piDeveloperCompleted: null,
          horizonSuccessful: null,
        },
      })
      return { outcome: "FOUND", presentation }
    }

    if (suppliedPersistence && (suppliedPersistence.refundId !== checkpoint.refundId || suppliedPersistence.paymentId !== checkpoint.paymentId || suppliedPersistence.idempotencyKey !== checkpoint.idempotencyKey)) return { outcome: "INDETERMINATE" }
    const persistence = suppliedPersistence?.result ?? await readRefundPresentationPersistence(checkpoint)
    if (persistence.outcome !== "FOUND") return { outcome: "INDETERMINATE" }

    let blockchain: RefundPresentationBlockchainReadResult
    if (
      checkpoint.stage === "audit_recorded" &&
      checkpoint.status === "completed" &&
      Object.values(persistence.timestamps).every((value) => value !== null)
    ) {
      if (suppliedProof && (suppliedProof.refundId !== checkpoint.refundId || suppliedProof.paymentId !== checkpoint.paymentId || suppliedProof.idempotencyKey !== checkpoint.idempotencyKey)) return { outcome: "INDETERMINATE" }
      const proof = suppliedProof?.result ?? await readRefundPresentationProof(checkpoint)
      if (proof.outcome === "INDETERMINATE") return { outcome: "INDETERMINATE" }
      if (proof.outcome === "FOUND") {
        blockchain = {
          outcome: "CONFIRMED",
          transactionAt: proof.proof.transactionAt,
          network: proof.proof.network,
          piTransactionVerified: proof.proof.piTransactionVerified,
          piDeveloperCompleted: proof.proof.piDeveloperCompleted,
          horizonSuccessful: proof.proof.horizonSuccessful,
        }
      } else {
        const blockchainRead = await readRefundPresentationBlockchain(checkpoint)
        if (blockchainRead.outcome !== "CONFIRMED" || blockchainRead.piDeveloperCompleted !== true) {
          return { outcome: "INDETERMINATE" }
        }
        if (!(await recordRefundPresentationProof(checkpoint, blockchainRead))) {
          return { outcome: "INDETERMINATE" }
        }
        blockchain = blockchainRead
      }
    } else {
      blockchain = await readRefundPresentationBlockchain(checkpoint)
      if (blockchain.outcome === "INDETERMINATE") return { outcome: "INDETERMINATE" }
    }

    const persisted = persistence.timestamps
    if (
      blockchain.outcome === "PENDING" &&
      [
        persisted.confirmationRecordedAt,
        persisted.accountingRecordedAt,
        persisted.auditRecordedAt,
        persisted.completedAt,
        persisted.finalizedAt,
      ].some((v) => v !== null)
    ) return { outcome: "INDETERMINATE" }
    if (blockchain.outcome === "CONFIRMED" && persisted.confirmationRecordedAt === null) {
      return { outcome: "INDETERMINATE" }
    }
    if (checkpoint.stage === "accounting_recorded" && persisted.accountingRecordedAt === null) {
      return { outcome: "INDETERMINATE" }
    }
    if (
      checkpoint.stage === "audit_recorded" &&
      (persisted.accountingRecordedAt === null || persisted.auditRecordedAt === null)
    ) return { outcome: "INDETERMINATE" }
    if (checkpoint.status === "completed" && persisted.completedAt === null) {
      return { outcome: "INDETERMINATE" }
    }
    if (persisted.finalizedAt !== null && persisted.completedAt === null) {
      return { outcome: "INDETERMINATE" }
    }

    const presentationBlockchain = blockchain.outcome === "PENDING"
      ? {
          confirmed: false,
          network: null,
          confirmationRecordedAt: null,
          transactionAt: null,
          piTransactionVerified: null,
          piDeveloperCompleted: null,
          horizonSuccessful: null,
        }
      : {
          confirmed: true,
          network: blockchain.network,
          confirmationRecordedAt: persisted.confirmationRecordedAt,
          transactionAt: blockchain.transactionAt,
          piTransactionVerified: blockchain.piTransactionVerified,
          piDeveloperCompleted: blockchain.piDeveloperCompleted,
          horizonSuccessful: blockchain.horizonSuccessful,
        }

    const presentation = buildRefundPresentationFromEvidence(checkpoint, {
      requestedAt: persisted.requestedAt,
      finalization: deriveRefundFinalizationFromPersistence(persisted),
      blockchain: presentationBlockchain,
    })

    return { outcome: "FOUND", presentation }
  } catch {
    return { outcome: "INDETERMINATE" }
  }
}
