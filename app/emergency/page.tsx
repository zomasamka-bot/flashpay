"use client"
import {RecoveryControl} from "@/components/recovery-control"
import {UIMessage} from "@/components/ui-message"
import {useI18n} from "@/components/i18n-provider"
import {FormEvent,useCallback,useEffect,useRef,useState} from "react"
import {AlertTriangle,CheckCircle2,Loader2,RefreshCw,ShieldCheck,Trash2} from "lucide-react"
import {BackButton} from "@/components/back-button"
import {Badge} from "@/components/ui/badge"
import {Button} from "@/components/ui/button"
import {Card,CardContent,CardDescription,CardHeader,CardTitle} from "@/components/ui/card"
import {config} from "@/lib/config"
import {useOwnerUid} from "@/lib/use-owner-uid"

type Review={paymentId:string;verdict:"Final"|"Recovering"|"Manual Review"|"Conflict"|"Unknown";reason:string;asOf:string;createdAt?:string;updatedAt?:string;parties:Record<string,unknown>;canonical:Record<string,unknown>;database:Record<string,unknown>;refund:Record<string,unknown>;durable?:Record<string,unknown>|null;action:{allowed:false;canRequestRecovery?:boolean;canPruneFromQueue?:boolean;message:string}}
type PaymentDiagnostic={paymentId:string;asOf?:string;diagnostic:string;canonical?:Record<string,unknown>;horizon?:{outcome?:string;observedSourceSequence?:string|null};binding?:{verdict?:string;failedChecks?:string[];checks?:Record<string,unknown>;expected?:Record<string,unknown>;observed?:Record<string,unknown>};refund?:{state?:string};safety?:Record<string,unknown>}
type Queue={available:true;asOf:string;items:Review[];visibility:{nextCursor:string|null;complete:boolean};note?:string|null}
const badge=(v:Review["verdict"])=>v==="Final"?"bg-green-600":v==="Recovering"?"bg-blue-600":v==="Conflict"?"bg-red-600":"bg-amber-600"
export default function EmergencyPage(){
 const {uidData}=useOwnerUid(),{locale}=useI18n(),ar=locale==='ar'
 const text=(en:string,arabic:string)=>ar?arabic:en
 const [queue,setQueue]=useState<Queue|null>(null),[selected,setSelected]=useState<Review|null>(null),[diagnostic,setDiagnostic]=useState<PaymentDiagnostic|null>(null)
 const [id,setId]=useState(''),[loading,setLoading]=useState(false),[error,setError]=useState(''),[busyId,setBusyId]=useState<string|null>(null),[wakeId,setWakeId]=useState<string|null>(null)
 const pending=useRef(false),actionPending=useRef(false)
 const owner=uidData.status==='success'&&uidData.uid===config.ownerUid&&Boolean(uidData.accessToken)
 const load=useCallback(async(cursor?:string)=>{
  if(!owner||!uidData.accessToken||pending.current)return
  pending.current=true;setLoading(true);setError('')
  try{
   const r=await fetch('/api/operations/payment-review'+(cursor?'?cursor='+encodeURIComponent(cursor):''),{headers:{Authorization:`Bearer ${uidData.accessToken}`},cache:'no-store'}),d=await r.json()
   if(!r.ok||d?.available!==true||!Array.isArray(d.items)||!d.visibility)throw Error(d?.error||'Review unavailable')
   setQueue(current=>cursor&&current?{...d,items:[...new Map([...current.items,...d.items].map(x=>[x.paymentId,x])).values()]}:d)
  }catch{setError('The queue could not be refreshed. Previously loaded records are retained; they may be outdated.')}
  finally{pending.current=false;setLoading(false)}
 },[owner,uidData.accessToken])
 useEffect(()=>{void load()},[load])
 const inspect=async(paymentId:string,diagnose=false)=>{
  if(!owner||!uidData.accessToken||actionPending.current)return
  actionPending.current=true;setBusyId(paymentId);setError('')
  try{
   const r=await fetch(`/api/operations/${diagnose?'payment-diagnostic':'payment-review'}?paymentId=${encodeURIComponent(paymentId)}`,{headers:{Authorization:`Bearer ${uidData.accessToken}`},cache:'no-store'}),d=await r.json()
   if(!r.ok)throw Error()
   if(diagnose){if(typeof d.diagnostic!=='string')throw Error();setDiagnostic(d)}
   else{if(!d.action||!d.canonical)throw Error();setSelected(d)}
  }catch{setError('The authoritative read is unavailable. No financial state was changed.')}
  finally{actionPending.current=false;setBusyId(null)}
 }
 const lookup=(e:FormEvent)=>{e.preventDefault();if(id.trim())void inspect(id.trim())}
 const remove=async(paymentId:string)=>{
  if(!owner||!uidData.accessToken||actionPending.current)return
  if(!window.confirm(text('Remove this proven terminal, unpaid item from the queue? The payment record and all financial evidence remain preserved.','إزالة هذا الطلب المنتهي المثبت عدم دفعه من القائمة؟ يبقى سجل الطلب وجميع الأدلة محفوظة.')))return
  actionPending.current=true;setBusyId(paymentId);setError('')
  try{
   const r=await fetch('/api/operations/payment-review',{method:'POST',headers:{Authorization:`Bearer ${uidData.accessToken}`,'Content-Type':'application/json'},body:JSON.stringify({action:'prune_terminal',paymentId})})
   if(!r.ok)throw Error();setSelected(null);await load()
  }catch{setError('Removal was not confirmed. Refresh the case; financial records remain protected.')}
  finally{actionPending.current=false;setBusyId(null)}
 }
 if(!owner)return <div className="p-4"><UIMessage text={uidData.status==='pending'?'Loading…':'Owner authorization required.'}/></div>
 const items=queue?.items??[]
 const stats=[[text('Loaded','المعروضة'),items.length],[text('Recovering','قيد الاستكمال'),items.filter(x=>x.verdict==='Recovering').length],[text('Review','للمراجعة'),items.filter(x=>x.verdict==='Manual Review'||x.verdict==='Unknown'||x.verdict==='Conflict').length],[text('Refunds','الاستردادات'),items.filter(x=>x.refund.state==='present').length]]
 const actions=(x:Review)=><div className="mt-3 flex flex-wrap gap-2">
  <Button variant="outline" size="sm" disabled={busyId!==null} onClick={()=>void inspect(x.paymentId)}>{busyId===x.paymentId?<Loader2 className="h-4 w-4 animate-spin"/>:text('Inspect details','عرض التفاصيل')}</Button>
  <Button variant="outline" size="sm" disabled={busyId!==null} onClick={()=>void inspect(x.paymentId,true)}>{text('Read-only diagnostic','تشخيص دون تعديل')}</Button>
  {x.action.canRequestRecovery&&<Button variant="outline" size="sm" onClick={()=>setWakeId(wakeId===x.paymentId?null:x.paymentId)}>{text('Request guarded recovery','طلب الاستكمال المحروس')}</Button>}
  {x.action.canPruneFromQueue&&<Button variant="destructive" size="sm" disabled={busyId!==null} onClick={()=>void remove(x.paymentId)}><Trash2 className="h-4 w-4"/>{text('Remove closed unpaid request','إزالة الطلب المنتهي غير المدفوع')}</Button>}
 </div>
 return <main id="emergency-top" data-emergency-scroll className="min-h-screen min-w-0 bg-background p-4 pb-28" style={{touchAction:'pan-y pinch-zoom'}}><div className="mx-auto min-w-0 max-w-5xl space-y-5">
  <BackButton/>
  <div className="flex items-start justify-between gap-3"><div className="min-w-0"><h1 className="text-2xl font-bold">{text('Recovery Command Center','مركز التعافي والطوارئ')}</h1><p className="mt-1 text-sm text-muted-foreground">{text('Current financial-kernel records and preserved legacy cases.','عمليات القلب المالي الحالي مع السجلات القديمة المحفوظة.')}</p></div><Button aria-label={text('Refresh queue','تحديث القائمة')} variant="outline" size="sm" disabled={loading} onClick={()=>void load()}>{loading?<Loader2 className="h-4 w-4 animate-spin"/>:<RefreshCw className="h-4 w-4"/>}</Button></div>
  <a className="inline-block underline" href="#recovery-queue">{text('Go to payment queue','الانتقال إلى قائمة العمليات')}</a>
  <Card><CardHeader><CardTitle>{text('Find a payment','البحث عن عملية')}</CardTitle></CardHeader><CardContent><form onSubmit={lookup} className="flex gap-2"><input aria-label="Payment ID" value={id} onChange={e=>setId(e.target.value)} placeholder={text('Payment ID','معرف العملية')} className="min-w-0 flex-1 rounded-md border bg-background p-2 font-mono text-sm"/><Button disabled={busyId!==null||!id.trim()}>{text('Inspect','فحص')}</Button></form></CardContent></Card>
  <details className="rounded-lg border p-3"><summary className="cursor-pointer font-semibold">{text('General guarded recovery','التعافي المحروس العام')}</summary><RecoveryControl accessToken={uidData.accessToken!} onRefresh={()=>void load()}/></details>
  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{stats.map(([label,value])=><Card key={String(label)}><CardContent className="p-3"><div className="text-xs text-muted-foreground">{label}</div><div className="text-2xl font-bold">{queue?value:'—'}</div></CardContent></Card>)}</div>
  {error&&<p role="alert" className="rounded border border-red-400 p-3 text-sm text-red-600"><UIMessage text={error}/></p>}
  <section id="recovery-queue" aria-label={text('Live recovery queue','قائمة العمليات الحالية')} className="min-w-0 space-y-3">
   <h2 className="text-xl font-semibold">{text('Live Recovery Queue','قائمة العمليات الحالية')}</h2>
   <p className="text-sm text-muted-foreground">{text('Completion or refund follows the original guards. Paid or uncertain cases cannot be terminated or erased. Only proven closed unpaid requests can be removed from this queue.','الإتمام أو الاسترداد يتبع الحراس الأصليين. لا يمكن إنهاء أو مسح عملية مدفوعة أو غير محسومة. الإزالة من القائمة تخص فقط طلبًا منتهيًا ثبت عدم دفعه.')}</p>
   {queue&&<p className="text-xs text-muted-foreground">{text('Last read: ','آخر قراءة: ')}{new Date(queue.asOf).toLocaleString()}</p>}
   {loading&&!queue&&<p role="status">{text('Loading current cases…','جارٍ قراءة العمليات الحالية…')}</p>}
   {queue&&items.length===0&&<p>{text('No cases on this page.','لا توجد عمليات في هذه الصفحة.')}</p>}
   {items.map(x=><article key={x.paymentId} className="min-w-0 rounded-lg border p-3">
    <div className="flex flex-wrap items-center justify-between gap-2"><span className="min-w-0 break-all font-mono text-xs">{x.paymentId}</span><Badge className={badge(x.verdict)}><UIMessage text={x.verdict}/></Badge></div>
    <div className="mt-2 grid grid-cols-2 gap-2 text-xs"><span>{text('Merchant: ','التاجر: ')}<b>{String(x.parties.merchantId??'—')}</b></span><span>{text('Amount: ','المبلغ: ')}<b>{String(x.canonical.customerAmount??'—')} π</b></span><span className="break-all">{text('State: ','الحالة: ')}{String(x.canonical.status??'—')}</span><span className="break-all">{text('Refund: ','الاسترداد: ')}{String(x.refund.status??x.refund.state??'—')}</span></div>
    <p className="mt-2 text-xs"><UIMessage text={x.reason}/></p>
    {Boolean(x.refund.lastErrorCode||x.canonical.lastErrorCode)&&<p className="mt-2 break-all text-xs text-amber-700">{text('Latest reason: ','آخر سبب: ')}{String(x.refund.lastErrorCode??x.canonical.lastErrorCode)}</p>}
    {Boolean(x.refund.nextRetryAt||x.canonical.nextRetryAt)&&<p className="mt-1 text-xs">{text('Next eligible check: ','المحاولة التالية المؤهلة: ')}{new Date(String(x.refund.nextRetryAt??x.canonical.nextRetryAt)).toLocaleString()}</p>}
    {actions(x)}
    {wakeId===x.paymentId&&<RecoveryControl key={x.paymentId} paymentId={x.paymentId} accessToken={uidData.accessToken!} onRefresh={()=>void load()}/>}
    {selected?.paymentId===x.paymentId&&<ReviewDetails review={selected}/>}
    {diagnostic?.paymentId===x.paymentId&&<DiagnosticDetails diagnostic={diagnostic}/>}
   </article>)}
   {queue?.visibility.nextCursor&&<Button variant="outline" disabled={loading} onClick={()=>void load(queue.visibility.nextCursor!)}>{loading?text('Loading…','جارٍ التحميل…'):text('Load more cases','عرض المزيد من العمليات')}</Button>}
   {queue?.visibility.complete&&<p className="text-xs text-muted-foreground">{text('End of indexed cases at the time of this read.','نهاية العمليات المفهرسة وقت القراءة.')}</p>}
  </section>
  {selected&&!items.some(x=>x.paymentId===selected.paymentId)&&<section>{actions(selected)}{wakeId===selected.paymentId&&<RecoveryControl key={selected.paymentId} paymentId={selected.paymentId} accessToken={uidData.accessToken!} onRefresh={()=>void load()}/>}<ReviewDetails review={selected}/></section>}
  {diagnostic&&!items.some(x=>x.paymentId===diagnostic.paymentId)&&<DiagnosticDetails diagnostic={diagnostic}/>}
  <a className="inline-block py-3 underline" href="#emergency-top">{text('Back to top','العودة إلى أعلى الصفحة')}</a>
 </div></main>
}
function ReviewDetails({review}:{review:Review}){return <div className="mt-4 space-y-4 border-t pt-4"><Card className={review.verdict==="Conflict"?"border-red-400":"border-amber-300"}><CardHeader><div className="flex items-center justify-between gap-2"><CardTitle className="flex items-center gap-2">{review.verdict==="Final"?<CheckCircle2 className="h-5 w-5"/>:<AlertTriangle className="h-5 w-5"/>}{review.verdict}</CardTitle><Badge className={badge(review.verdict)}>{String(review.canonical.status??"Unknown")}</Badge></div><CardDescription><UIMessage text={review.reason} /></CardDescription></CardHeader></Card><div className="grid gap-4 md:grid-cols-2"><Detail title="Parties" data={review.parties}/><Detail title="Canonical Financial State" data={review.canonical}/><Detail title="Refund Checkpoint" data={review.refund}/><Detail title="Database Cross-check" data={review.database}/>{review.durable&&<Detail title="Durable checkpoint" data={review.durable}/>}</div><Card className="border-blue-300"><CardContent className="flex gap-3 pt-6"><ShieldCheck className="h-5 w-5 shrink-0 text-blue-600"/><div><b> <UIMessage text={"Safe operator disposition"} /> </b><p className="mt-1 text-sm"><UIMessage text={review.action.message} /></p><p className="mt-2 text-xs text-muted-foreground"> <UIMessage text={"This console never deletes financial evidence, invents status, submits Horizon transactions, creates refunds, or bypasses wallet/recovery locks."} /> </p></div></CardContent></Card></div>}
function Detail({title,data}:{title:string;data:Record<string,unknown>}){const e=Object.entries(data).filter(([,v])=>v!==null&&v!==undefined);return <Card><CardHeader><CardTitle><UIMessage text={title} /></CardTitle></CardHeader><CardContent className="space-y-2">{e.map(([k,v])=><div key={k} className="rounded-md border p-2"><div className="text-xs text-muted-foreground">{k}</div><div className="break-all font-mono text-sm">{String(v)}</div></div>)}</CardContent></Card>}

function DiagnosticDetails({diagnostic}:{diagnostic:PaymentDiagnostic}){return <Card className="border-violet-400"><CardHeader><CardTitle> <UIMessage text={"Prepared / Horizon Diagnostic"} /> </CardTitle><CardDescription> <UIMessage text={"Owner-only read-only evidence. This action never submits a transaction or mutates payment/refund state."} /> </CardDescription></CardHeader><CardContent className="space-y-3"><div className="rounded-md border p-3"><div className="text-xs text-muted-foreground"> <UIMessage text={"Classification"} /> </div><div className="break-all font-mono text-sm font-semibold">{diagnostic.diagnostic}</div></div>{diagnostic.horizon&&<Detail title="Horizon Read" data={diagnostic.horizon as Record<string,unknown>}/>} {diagnostic.binding&&<><Detail title="Binding Verdict" data={{verdict:diagnostic.binding.verdict??"—",failedChecks:(diagnostic.binding.failedChecks??[]).join(", ")||"none"}}/><Detail title="Binding Checks" data={diagnostic.binding.checks??{}}/><Detail title="Expected Horizon Evidence" data={diagnostic.binding.expected??{}}/><Detail title="Observed Horizon Evidence" data={diagnostic.binding.observed??{}}/></>} {diagnostic.canonical&&<Detail title="Prepared Settlement Checkpoint" data={diagnostic.canonical}/>}<p className="text-xs text-muted-foreground"> <UIMessage text={"Read-only: no Horizon submit, no stored XDR returned, no Redis/DB write, no refund, no status mutation."} /> </p></CardContent></Card>}
