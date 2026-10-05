import fs from'node:fs'
const s=fs.readFileSync('app/api/certification/fin4-r4t-lock-diagnostic/route.ts','utf8')
const required=x=>[
 "export async function GET",
 "fin4AuthorizeRunId(request.headers.get('x-flashpay-fin4-run-id'))",
 "resolveFin4R4TSourceWallet()",
 "if(!resolved.ok)return NextResponse.json",
 "readFin4R4TSubmitLockDiagnostic(resolved.sourceWallet)",
 "lockAcquisitionExecuted:false","redisMutationExecuted:false","piMutationExecuted:false","horizonSubmitExecuted:false","financialAuthorityMutated:false"
].every(k=>x.includes(k))
const safe=x=>required(x)&&!['acquirePiWalletSubmitLock','holdFin4R4TWalletProbe','contendFin4R4TWalletProbe','redis.set(','redis.del(','redis.eval(','executeA2U(','executeRefund'].some(k=>x.includes(k))&&!/export\s+async\s+function\s+POST\b/.test(x)
const muts=[
 ['drop resolver gate',s.replace("if(!resolved.ok)return NextResponse.json","if(false)return NextResponse.json")],
 ['add acquisition',s+"\\n// acquirePiWalletSubmitLock"],
 ['add holder',s+"\\n// holdFin4R4TWalletProbe"],
 ['add redis set',s+"\\n// redis.set("],
 ['claim acquisition',s.replaceAll("lockAcquisitionExecuted:false","lockAcquisitionExecuted:true")],
 ['claim redis mutation',s.replaceAll("redisMutationExecuted:false","redisMutationExecuted:true")],
 ['expose POST',s+"\\nexport async function POST(){}"],
]
for(const [n,x] of muts)if(safe(x))throw Error(`SURVIVED mutation: ${n}`)
console.log(`PASS verify-fin4-r4t51-read-only-lock-diagnostic-route-mutations (${muts.length} killed)`)
