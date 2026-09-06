import "server-only"

import { getRefundCheckpointReadOnly } from "./refund-checkpoint-store"
import type { RefundCheckpointReadOnly } from "./refund-checkpoint-store"
import { readRefundPresentationBlockchain } from "./refund-presentation-blockchain"
import {
  readRefundPresentationPersistence,
  readRefundPresentationProof,
  recordRefundPresentationProof,
} from "./refund-presentation-persistence"
import {
  buildRefundPresentationFromEvidence,
  deriveRefundFinalizationFromPersistence,
} from "./refund-presentation"
import type {
  RefundCheckpoint,
  RefundPresentationBlockchainReadResult,
  RefundPresentationReadResult,
} from "./types"

export async function readRefundPresentation(refundId: string, suppliedCheckpoint?: RefundCheckpoint): Promise<RefundPresentationReadResult> {
  try {
    const checkpointResult: RefundCheckpointReadOnly = suppliedCheckpoint && suppliedCheckpoint.refundId === refundId && suppliedCheckpoint.stage === "audit_recorded" && suppliedCheckpoint.status === "completed"
      ? { state: "present", checkpoint: suppliedCheckpoint }
      : await getRefundCheckpointReadOnly(refundId)
    if (checkpointResult.state === "absent") return { outcome: "NOT_FOUND" }
    if (checkpointResult.state === "uncertain") return { outcome: "INDETERMINATE" }

    const checkpoint = checkpointResult.checkpoint
    const persistence = await readRefundPresentationPersistence(checkpoint)
    if (persistence.outcome !== "FOUND") return { outcome: "INDETERMINATE" }

    let blockchain: RefundPresentationBlockchainReadResult
    if (
      checkpoint.stage === "audit_recorded" &&
      checkpoint.status === "completed" &&
      Object.values(persistence.timestamps).every((value) => value !== null)
    ) {
      const proof = await readRefundPresentationProof(checkpoint)
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
