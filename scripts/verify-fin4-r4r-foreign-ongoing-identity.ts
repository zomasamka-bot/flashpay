import fs from "fs";import path from "path";
const e=fs.readFileSync(path.join(process.cwd(),"lib/a2u-executor.ts"),"utf8")
function need(v:boolean,n:string){if(!v)throw new Error(`R4R:${n}`)}
const fetchPos=e.indexOf("const fetchResult = await fetchA2UPayment(ongoingPaymentId)")
const bindPos=e.indexOf("const exactOngoingIdentity = Boolean(",fetchPos)
const capturePos=e.indexOf("recordSettlementA2UOngoingObservation(ctx.paymentId, ongoingPaymentId)",fetchPos)
need(fetchPos>=0,"server_get")
need(bindPos>fetchPos,"exact_bind_after_get")
need(capturePos>bindPos,"capture_only_after_bind")
need(e.includes('metadata?.paymentId === ctx.paymentId')&&e.includes('metadata.type === "a2u_settlement"'),"metadata_binding")
need(e.includes('fetchResult.amount === ctx.customerAmount')&&e.includes('fetchResult.user_uid === ctx.merchantUid')&&e.includes('fetchResult.direction === "app_to_user"'),"financial_binding")
need(e.includes('[R4R] FOREIGN_ONGOING_PAYMENT')&&e.includes('errorCode:"a2u_foreign_ongoing_payment"'),"foreign_classification")
need(!e.slice(fetchPos,capturePos).includes("recordSettlementA2UOngoingObservation"),"no_prebind_capture")
console.log("FIN4_R4R_FOREIGN_ONGOING_IDENTITY=PASS fetch_before_capture=true exact_binding=true foreign_classification=true no_financial_promotion=true")
