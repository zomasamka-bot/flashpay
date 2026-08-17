import "server-only"

import { getRefundCheckpointReadOnly } from "./refund-checkpoint-store"
import { readRefundPresentationBlockchain } from "./refund-presentation-blockchain"
import { readRefundPresentationPersistence } from "./refund-presentation-persistence"
import {
  buildRefundPresentationFromEvidence,
  deriveRefundFinalizationFromPersistence,
} from "./refund-presentation"
import type { RefundPresentationReadResult } from "./types"

export async function readRefundPresentation(refundId: string): Promise<RefundPresentationReadResult> {
  try {
    const checkpointResult = await getRefundCheckpointReadOnly(refundId)
    if (checkpointResult.state === "absent") return { outcome: "NOT_FOUND" }
    if (checkpointResult.state === "uncertain") return { outcome: "INDETERMINATE" }

    const checkpoint = checkpointResult.checkpoint
    const persistence = await readRefundPresentationPersistence(checkpoint)
    if (persistence.outcome !== "FOUND") return { outcome: "INDETERMINATE" }

    const blockchain = await readRefundPresentationBlockchain(checkpoint)
    if (blockchain.outcome === "INDETERMINATE") return { outcome: "INDETERMINATE" }

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
