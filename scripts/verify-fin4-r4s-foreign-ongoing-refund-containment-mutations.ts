import fs from "node:fs"; import path from "node:path";
const root=process.cwd(); const E=fs.readFileSync(path.join(root,"lib/a2u-executor.ts"),"utf8"); const T=fs.readFileSync(path.join(root,"lib/types.ts"),"utf8");
function valid(e:string,t:string){return e.includes('const failClosedStage1=["a2u_foreign_ongoing_payment"')&&t.includes('failure.code === "a2u_foreign_ongoing_payment" ||')}
if(!valid(E,T))throw new Error("baseline invalid");
const muts=[
 ["executor_guard",E.replace('"a2u_foreign_ongoing_payment",',''),T],
 ["eligibility_guard",E,T.replace('    failure.code === "a2u_foreign_ongoing_payment" ||\n','')],
] as const;
for(const [n,e,t] of muts){if(valid(e,t))throw new Error(`FAIL mutation survived ${n}`);console.log(`PASS mutation killed ${n}`)}
console.log("FIN4_R4S_FOREIGN_ONGOING_REFUND_CONTAINMENT_MUTATIONS PASS")
