import crypto from "node:crypto"

type Role="A"|"B"
type Payload={v:"fin4-r4e-v1";runId:string;role:Role;paymentId:string;deploymentHost:string;iat:number;exp:number;nonce:string}
const secret="A".repeat(32)
const ttl=60_000
const now=1_791_144_000_000
const runId="FIN4-20261004-1742-A7B9"
const host="flashpay-r4e-example.vercel.app"
const paymentA="7e95c0ef-bd41-4db7-9100-ece47ad703d7"
const paymentB="e3b83ecd-9f5e-4963-b75f-e3ef058cf095"

function sig(encoded:string){return crypto.createHmac("sha256",secret).update(`flashpay-fin4-r4e-capability:${encoded}`).digest("base64url")}
function issue(role:Role,paymentId:string):string{
  const p:Payload={v:"fin4-r4e-v1",runId,role,paymentId,deploymentHost:host,iat:now,exp:now+ttl,nonce:role==="A"?"11111111-1111-4111-8111-111111111111":"22222222-2222-4222-8222-222222222222"}
  const encoded=Buffer.from(JSON.stringify(p)).toString("base64url")
  return `${encoded}.${sig(encoded)}`
}
function verify(token:string,role:Role,paymentId:string,expectedHost=host,at=now+1):boolean{
  try{
    const [encoded,supplied,...rest]=token.split("."); if(!encoded||!supplied||rest.length)return false
    const expected=sig(encoded); const a=Buffer.from(supplied),b=Buffer.from(expected); if(a.length!==b.length||!crypto.timingSafeEqual(a,b))return false
    const p=JSON.parse(Buffer.from(encoded,"base64url").toString("utf8")) as Payload
    if(Object.keys(p).sort().join(",")!=="deploymentHost,exp,iat,nonce,paymentId,role,runId,v")return false
    if(p.v!=="fin4-r4e-v1"||p.runId!==runId||p.role!==role||p.paymentId!==paymentId||p.deploymentHost!==expectedHost)return false
    if(p.exp<=p.iat||p.exp-p.iat!==ttl||at>p.exp)return false
    return true
  }catch{return false}
}
function need(v:boolean,m:string){if(!v)throw new Error(m)}
const a=issue("A",paymentA), b=issue("B",paymentB)
need(verify(a,"A",paymentA),"A capability must verify for A")
need(verify(b,"B",paymentB),"B capability must verify for B")
need(!verify(a,"B",paymentB),"A capability must not authorize B")
need(!verify(b,"A",paymentA),"B capability must not authorize A")
need(!verify(a,"A",paymentB),"capability must not cross payment scope")
need(!verify(a,"A",paymentA,"other.vercel.app"),"capability must not cross deployment scope")
need(!verify(a,"A",paymentA,host,now+ttl+1),"expired capability must fail")
const [encoded,s]=a.split("."); const tampered=Buffer.from(Buffer.from(encoded,"base64url").toString("utf8").replace(paymentA,paymentB)).toString("base64url")+`.${s}`
need(!verify(tampered,"A",paymentA),"tampered payload must fail signature")
const extraPayload={...JSON.parse(Buffer.from(encoded,"base64url").toString("utf8")),extra:true}; const extraEncoded=Buffer.from(JSON.stringify(extraPayload)).toString("base64url")
need(!verify(`${extraEncoded}.${sig(extraEncoded)}`,"A",paymentA),"extra capability fields must fail exact shape")
console.log("FIN4_R4E_CAPABILITY_MODEL=PASS cases=9 role_scope=true payment_scope=true deployment_scope=true expiry=true tamper_rejected=true exact_shape=true")
