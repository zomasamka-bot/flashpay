import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID, createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { after } from 'next/server'

// Observation only: no authority, financial writes, retries, response mutation,
// request body reads or dependency on successful delivery of diagnostics.
type Identity = { paymentId?: unknown; refundId?: unknown; piId?: unknown; intentId?: unknown }
type Event = Record<string, string | number | boolean | null>
type Root = { traceId: string; identity: Identity; events: Event[]; dropped: number }
type Context = { root: Root; spanId: string }
const scope = new AsyncLocalStorage<Context>()
const validId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(v)
const token = (v: unknown) => typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]{0,95}$/.test(v) ? v : undefined
const enabled = () => process.env.FLASHPAY_FINANCIAL_TRACE !== 'off'
function identities(value: Identity): Identity {
 const out: Identity = {}
 for (const k of ['paymentId','refundId','piId','intentId'] as const) if(validId(value[k])) out[k]=value[k]
 return out
}
export function bindFinancialTrace(value: Identity): void {
 try {
  const c=scope.getStore();if(!c)return
  const safe=identities(value)
  if(safe.paymentId && c.root.identity.paymentId && safe.paymentId!==c.root.identity.paymentId)return
  Object.assign(c.root.identity,safe)
 } catch {}
}
function emit(event: Event): void {
 try {
  const c=scope.getStore();if(!c)return
  if(c.root.events.length>=256){c.root.dropped++;return}
  const row:Event={v:1,at:new Date().toISOString(),traceId:c.root.traceId,spanId:c.spanId,...event}
  for(const [k,v] of Object.entries(c.root.identity))if(typeof v==='string')row[k]=v
  c.root.events.push(row)
  console.info('[FP_TRACE]',JSON.stringify(row))
 } catch {}
}
function resultFacts(value:unknown,depth=0):Event {
 const facts:Event={}
 try {
  if(value instanceof Response)return {httpStatus:value.status}
  if(typeof value==='boolean')return {value}
  if(value===null)return {value:null}
  if(typeof value==='string'){const t=token(value);return t?{outcome:t}:facts}
  if(Array.isArray(value))return {rows:value.length}
  if(!value||typeof value!=='object')return facts
  const r=value as Record<string,unknown>
  for(const k of ['ok','success','retryable','isFinal','replayed'])if(typeof r[k]==='boolean')facts[k]=r[k] as boolean
  for(const k of ['stage','state','status','outcome','reason','code','errorCode','path']){const t=token(r[k]);if(t)facts[k]=t}
  for(const k of ['retryAfterMs','generation','durationMs'])if(typeof r[k]==='number'&&Number.isFinite(r[k]))facts[k]=r[k] as number
  if(depth===0 && r.result && typeof r.result==='object')for(const[k,v]of Object.entries(resultFacts(r.result,1)))facts['result_'+k]=v
 }catch{}
 return facts
}
function errorFacts(error:unknown):Event {
 try {
  const e=error as {name?:unknown;code?:unknown;message?:unknown}
  const name=['Error','TypeError','RangeError','AbortError','TimeoutError','SyntaxError'].includes(String(e?.name))?String(e.name):'Error'
  const code=token(e?.code)
  return {errorClass:name,...(code?{errorCode:code}:{}),...(typeof e?.message==='string'?{errorDigest:createHash('sha256').update(e.message).digest('hex').slice(0,16)}:{})}
 }catch{return {errorClass:'Error'}}
}
let activeWrites=0
async function captureResponse(response:Response,root:Root){
 let reader:ReadableStreamDefaultReader<Uint8Array>|undefined,timer:ReturnType<typeof setTimeout>|undefined
 try{
  reader=response.body?.getReader();if(!reader)return
  let text='',size=0;const decoder=new TextDecoder()
  const read=async()=>{for(;;){const part=await reader!.read();if(part.done)break;size+=part.value.byteLength;if(size>65536)return;text+=decoder.decode(part.value,{stream:true})}const body=JSON.parse(text);const candidate=body?.paymentId??body?.payment?.id
   if(!root.identity.paymentId&&validId(candidate))root.identity.paymentId=candidate
   root.events.push({v:1,at:new Date().toISOString(),traceId:root.traceId,phase:'http.route',event:'response',httpStatus:response.status,...resultFacts(body)})
  }
  await Promise.race([read(),new Promise<void>(resolve=>{timer=setTimeout(resolve,1000)})])
 }catch{}finally{if(timer)clearTimeout(timer);try{void reader?.cancel().catch(()=>{})}catch{}}
}
function flush(root:Root,response?:Response):void {
 try {
  // Rejected anonymous requests remain in runtime logs; they cannot evict
  // authenticated financial timelines from the bounded diagnostic cache.
  if(response && (response.status===401||response.status===403))return
  const copy=response?.clone()
  const persistFinancialTrace=async()=>{
   if(activeWrites>=32){try{console.info('[FP_TRACE_STORE]',JSON.stringify({traceId:root.traceId,state:'capacity',financialEffect:false}))}catch{};return}
   activeWrites++
   try{
    if(copy)await captureResponse(copy,root)
    const events=root.events.map(e=>({...e,...identities(root.identity)})) as Event[]
    if(root.dropped)events.push({v:1,at:new Date().toISOString(),traceId:root.traceId,phase:'trace.capacity',event:'truncated',dropped:root.dropped})
    const identity=root.identity.paymentId??root.identity.intentId??root.identity.refundId
    if(!validId(identity)||!events.length)return
    const m=await import('./financial-trace-store');await m.storeFinancialTrace(identity,events)
   }catch{try{console.info('[FP_TRACE_STORE]',JSON.stringify({traceId:root.traceId,state:'unavailable',financialEffect:false}))}catch{}}
   finally{activeWrites--}
  }
  try{after(persistFinancialTrace)}catch{void persistFinancialTrace()}
 }catch{}
}
export async function traceFinancial<T>(phase:string,identity:()=>Identity,work:()=>Promise<T>):Promise<T>{
 if(!enabled())return work()
 let c:Context,owns=false,started:number,parentId:string|null=null
 try {
  const parent=scope.getStore(),safe=identities(identity())
  const separate=!!safe.paymentId&&parent?.root.identity.paymentId!==safe.paymentId
  owns=!parent||separate
  const root=owns?{traceId:randomUUID(),identity:safe,events:[],dropped:0}:parent!.root
  Object.assign(root.identity,safe)
  parentId=parent?.spanId??null;c={root,spanId:randomUUID()};started=performance.now()
 }catch{return work()}
 return scope.run(c,async()=>{
  let response:Response|undefined
  emit({phase,event:'begin',parentSpanId:parentId})
  try{const result=await work();if(result instanceof Response)response=result;emit({phase,event:'end',elapsedMs:Math.round((performance.now()-started)*10)/10,...resultFacts(result)});return result}
  catch(error){emit({phase,event:'throw',elapsedMs:Math.round((performance.now()-started)*10)/10,...errorFacts(error)});throw error}
  finally{if(owns)flush(c.root,response)}
 })
}
export function financialTraceFacts(phase:string,facts:Record<string,unknown>):void {
 try {emit({phase,event:'detail',...resultFacts(facts)})}catch{}
}
// The original Response object/body and original fetch error are returned intact.
export async function tracedFinancialFetch(input:Parameters<typeof fetch>[0],init?:Parameters<typeof fetch>[1]):Promise<Response>{
 let endpoint='service',method='GET'
 try{
  const u=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url)
  method=init?.method??(input instanceof Request?input.method:'GET')
  if(u.hostname==='api.minepi.com')endpoint='pi'+u.pathname.replace(/\/payments\/[^/]+/,'/payments/:id')
  else if(u.hostname.endsWith('.minepi.com'))endpoint='horizon'+u.pathname.replace(/\/(accounts|transactions)\/[^/]+/g,'/$1/:id')
 }catch{}
 return traceFinancial('http.'+method+'.'+endpoint,()=>({}),async()=>{
  const response=await fetch(input,init)
  try{const requestId=response.headers.get('x-request-id'),retryAfter=response.headers.get('retry-after');emit({phase:'http.response',event:'detail',httpStatus:response.status,...(validId(requestId)?{providerRequestId:requestId}:{}),...(retryAfter&&/^[0-9]{1,10}$/.test(retryAfter)?{retryAfterSeconds:Number(retryAfter)}:{})})}catch{}
  return response
 })
}
