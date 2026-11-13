// KERNEL-1: original guarded handlers; no host financial decisions.
export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export async function GET(request: import("next/server").NextRequest) {
  const { GET: readDomainState } = await import("@flashpay/financial-kernel/handlers/control/domain/route")
  return readDomainState(request)
}
// Owner-requested suspension. Keep the authenticated read path and existing
// financial/system controls intact; stale clients cannot change domain state.
export function POST() {
  return Response.json({ error: "Domain activation is suspended", code: "DOMAIN_CONTROLS_SUSPENDED" }, { status: 403, headers: { "Cache-Control": "no-store" } })
}
