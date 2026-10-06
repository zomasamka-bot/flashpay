import { type NextRequest, NextResponse } from "next/server"
import { fin4AuthorizeRunId } from "@/lib/fin4-live-certification"
import { retireB, retireC } from "@/lib/fin4-r4t63-leftovers-cleanup"
export const dynamic="force-dynamic";export const runtime="nodejs";export const maxDuration=90
export async function POST(req:NextRequest){
 const runId=fin4AuthorizeRunId(req.headers.get("x-flashpay-fin4-run-id"));if(!runId)return NextResponse.json({error:"Unauthorized"},{status:403})
 const body=await req.json().catch(()=>null);const action=body?.action
 if((action!=="retire-c"&&action!=="retire-b")||Object.keys(body??{}).length!==1)return NextResponse.json({error:"Invalid body"},{status:400})
 const result=action==="retire-c"?await retireC():await retireB()
 console.warn("[FIN-4 R4T6.3 LEFTOVER CLEANUP]",{runId,action,...result})
 return NextResponse.json({action,...result},{status:result.ok?200:409})
}
