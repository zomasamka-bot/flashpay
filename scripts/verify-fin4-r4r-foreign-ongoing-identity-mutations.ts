import fs from "fs";import path from "path";const E=fs.readFileSync(path.join(process.cwd(),"lib/a2u-executor.ts"),"utf8")
function valid(e:string){const f=e.indexOf("const fetchResult = await fetchA2UPayment(ongoingPaymentId)"),b=e.indexOf("const exactOngoingIdentity = Boolean(",f),c=e.indexOf("recordSettlementA2UOngoingObservation(ctx.paymentId, ongoingPaymentId)",f);if(!(f>=0&&b>f&&c>b))return false;const block=e.slice(b,c);return block.includes('metadata?.paymentId === ctx.paymentId')&&block.includes('fetchResult.amount === ctx.customerAmount')&&block.includes('fetchResult.user_uid === ctx.merchantUid')&&block.includes('fetchResult.direction === "app_to_user"')&&e.slice(c,c+1800).includes('errorCode:"a2u_foreign_ongoing_payment"')}
function mutateInR4R(e:string,from:string,to:string){const start=e.indexOf("const exactOngoingIdentity = Boolean(");if(start<0)throw new Error("R4R block missing");const pos=e.indexOf(from,start);if(pos<0)throw new Error(`R4R mutation target missing:${from}`);return e.slice(0,pos)+to+e.slice(pos+from.length)}
const muts:[string,string][]=[
 ["payment_binding",mutateInR4R(E,'metadata?.paymentId === ctx.paymentId','true')],
 ["amount_binding",mutateInR4R(E,'fetchResult.amount === ctx.customerAmount','true')],
 ["uid_binding",mutateInR4R(E,'fetchResult.user_uid === ctx.merchantUid','true')],
 ["direction_binding",mutateInR4R(E,'fetchResult.direction === "app_to_user"','true')],
 ["foreign_code",mutateInR4R(E,'errorCode:"a2u_foreign_ongoing_payment"','errorCode:"x"')],
 ["capture_removed",mutateInR4R(E,'recordSettlementA2UOngoingObservation(ctx.paymentId, ongoingPaymentId)','Promise.resolve("RECORDED")')]
]
if(!valid(E))throw new Error("R4R baseline invalid");let failures=0;for(const [n,m] of muts){if(valid(m))throw new Error(`R4R mutation unexpectedly passed:${n}`);failures++}console.log(`FIN4_R4R_MUTATIONS=PASS expected_failures=${muts.length} actual_failures=${failures}`)
