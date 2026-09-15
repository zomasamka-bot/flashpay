import "server-only"

import { publicConfig } from "@/lib/public-config"

export type OwnerAuthResult =
  | { ok: true; uid: string; status: 200 }
  | { ok: false; status: 401 | 403 | 500 | 503 }

export async function verifyOwnerAuthorizationHeader(authorization: string | null): Promise<OwnerAuthResult> {
  if (!publicConfig.isOwnerConfigured || !publicConfig.ownerUid) return { ok: false, status: 500 }
  if (!authorization?.startsWith("Bearer ")) return { ok: false, status: 401 }

  const token = authorization.slice(7).trim()
  if (!token) return { ok: false, status: 401 }

  let response: Response
  try {
    response = await fetch("https://api.minepi.com/v2/me", {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    })
  } catch {
    return { ok: false, status: 503 }
  }

  if (!response.ok) return { ok: false, status: 401 }

  let data: unknown
  try {
    data = await response.json()
  } catch {
    return { ok: false, status: 503 }
  }

  if (!data || typeof data !== "object") return { ok: false, status: 401 }
  const record = data as Record<string, unknown>
  const uid =
    typeof record.uid === "string" ? record.uid :
    typeof record.userId === "string" ? record.userId :
    typeof record.user_id === "string" ? record.user_id :
    ""

  if (!uid) return { ok: false, status: 401 }
  if (uid !== publicConfig.ownerUid) return { ok: false, status: 403 }
  return { ok: true, uid, status: 200 }
}
