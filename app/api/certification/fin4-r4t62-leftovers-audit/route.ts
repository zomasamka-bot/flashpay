import { NextRequest, NextResponse } from "next/server"
import { fin4AuthorizeRunId } from "@/lib/fin4-live-certification"
import { readFin4R4T62LeftoversAudit } from "@/lib/fin4-r4t62-leftovers-audit"

export const dynamic="force-dynamic"
export const runtime="nodejs"

export async function GET(request:NextRequest){
  const runId=fin4AuthorizeRunId(request.headers.get("x-flashpay-fin4-run-id"))
  if(!runId)return NextResponse.json({error:"Unauthorized"},{status:403})
  const audit=await readFin4R4T62LeftoversAudit()
  return NextResponse.json({...audit,runId},{status:audit.ok?200:503})
}
