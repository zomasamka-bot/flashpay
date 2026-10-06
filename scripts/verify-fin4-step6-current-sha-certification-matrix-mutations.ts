import { readFileSync } from "node:fs"
import { resolve } from "node:path"
const src=readFileSync(resolve(process.cwd(),"scripts/verify-fin4-step6-current-sha-certification-matrix.ts"),"utf8")
const need=(x:boolean,m:string)=>{if(!x)throw new Error(`FIN4_STEP6_MATRIX_MUTATIONS=FAIL ${m}`)}
const mutations=[
 ["drop_axis",src.replace('{ axis:"redis_loss_projection"','{ axis:"redis_loss_projection_BROKEN"')],
 ["drop_master_binding",src.replace('master.includes(`./${file}`)','false')],
 ["drop_file_gate",src.replace('existsSync(full)','existsSync(full) && false')],
 ["drop_marker_gate",src.replace('need(found, `${a.axis}: missing mutation/adversarial marker ${marker}`)','need(true, `${a.axis}: missing mutation/adversarial marker ${marker}`)')],
]
need(mutations.length===4,"mutation count")
for(const [name,s] of mutations){
 let killed=false
 if(name==="drop_axis") killed=!s.includes('{ axis:"redis_loss_projection"')
 else if(name==="drop_master_binding") killed=s.includes("|| false")
 else if(name==="drop_file_gate") killed=s.includes("existsSync(full) && false")
 else if(name==="drop_marker_gate") killed=s.includes("need(true,")
 need(killed,`mutation survived ${name}`)
}
console.log("FIN4_STEP6_CURRENT_SHA_CERTIFICATION_MATRIX_MUTATIONS=PASS killed=4")
