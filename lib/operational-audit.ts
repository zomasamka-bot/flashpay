import "server-only"

import { randomUUID } from "crypto"
import { redis, isRedisConfigured } from "@/lib/redis"

const AUDIT_KEY = "flashpay:operations:audit:v1"
const MAX_EVENTS = 500

export type OperationalAuditAction = "control.enable" | "control.disable" | "control.reset"

export interface OperationalAuditEvent {
  eventId: string
  action: OperationalAuditAction
  actorUid: string
  requestId: string
  createdAt: number
  previousRevision: number
  resultingRevision: number
  previousEnabled: boolean
  resultingEnabled: boolean
  reason: string
}

function safeReason(value: unknown): string {
  if (typeof value !== "string") return ""
  return value.trim().slice(0, 240)
}

export async function appendOperationalAuditEvent(input: Omit<OperationalAuditEvent, "eventId" | "createdAt" | "reason"> & { reason?: unknown }): Promise<void> {
  if (!isRedisConfigured) throw new Error("Operational audit Redis is not configured")

  const event: OperationalAuditEvent = {
    ...input,
    eventId: randomUUID(),
    createdAt: Date.now(),
    reason: safeReason(input.reason),
  }

  // Append-only bounded operational history. No financial identifiers, tokens, XDR or secrets.
  await redis.lpush(AUDIT_KEY, JSON.stringify(event))
  await redis.ltrim(AUDIT_KEY, 0, MAX_EVENTS - 1)
}
