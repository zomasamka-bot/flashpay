"use client"
import {useCallback,useEffect,useState,useRef} from "react"
import {useI18n} from "@/components/i18n-provider"
import {Button} from "@/components/ui/button"
export function RecoveryControl({accessToken,onRefresh}:{accessToken:string;onRefresh:()=>void}){
 const {locale}=useI18n(),ar=locale==='ar'
 const [reason,setReason]=useState(''),[confirm,setConfirm]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[last,setLast]=useState<{state:string;requestedAt:string;finishedAt?:string}|null>(null)
 const pending=useRef(false)
 const status=useCallback(async()=>{try{const r=await fetch('/api/operations/recovery',{headers:{Authorization:`Bearer ${accessToken}`},cache:'no-store'});if(r.ok)setLast((await r.json()).last)}catch{}},[accessToken])
 useEffect(()=>{void status()},[status])
 const wake=async()=>{
  if(pending.current||!confirm||!reason.trim())return;pending.current=true;setBusy(true);setMessage('')
  try{const r=await fetch('/api/operations/recovery',{method:'POST',headers:{Authorization:`Bearer ${accessToken}`,'Content-Type':'application/json'},body:JSON.stringify({action:'wake',reason:reason.trim()})}),d=await r.json();if(r.status===429){setMessage(ar?'يوجد طلب تعافٍ حديث؛ حدّث الحالة قبل المحاولة مجددًا.':'Recovery was recently requested; refresh its status before retrying.');return}if(!r.ok||d.accepted!==true)throw new Error();setConfirm(false);setReason('');setMessage(ar?'تم طلب التعافي المحروس. قبول الطلب لا يعني اكتمال العمليات؛ راجع القائمة.':'Guarded recovery requested. Acceptance does not mean payments are complete; inspect the queue.');await status();onRefresh()}
  catch{setMessage(ar?'تعذر تأكيد طلب التعافي. حدّث الحالة قبل إعادة المحاولة.':'Recovery request could not be confirmed. Refresh status before retrying.')}
  finally{pending.current=false;setBusy(false)}
 }
 return <section className="space-y-3 rounded-lg border p-4"><h2 className="font-semibold">{ar?'التعافي الطارئ للمدفوعات':'Emergency payment recovery'}</h2><p className="text-sm text-muted-foreground">{ar?'تشغيل فحص الاستكمال الحالي للعمليات المعلقة. تبقى الشهادات والحراس شرطًا للتنفيذ؛ لا يغيّر الجدول الآلي.':'Wake the existing recovery check for unfinished payments. Certificates and guards remain required; the automatic schedule is unchanged.'}</p>
 <label className="block text-sm">{ar?'سبب التشغيل':'Reason'}<textarea className="mt-1 block w-full rounded border bg-background p-2" maxLength={240} value={reason} onChange={e=>{setReason(e.target.value);setConfirm(false)}} disabled={busy}/></label>
 <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={confirm} onChange={e=>setConfirm(e.target.checked)} disabled={busy}/>{ar?'أطلب فحصًا محروسًا دون فرض نتيجة مالية.':'Request a guarded check without forcing a financial outcome.'}</label>
 <div className="flex flex-wrap gap-2"><Button onClick={()=>void wake()} disabled={busy||!confirm||!reason.trim()}>{ar?'تشغيل التعافي المحروس':'Run guarded recovery'}</Button><Button variant="outline" disabled={busy} onClick={()=>{void status();onRefresh()}}>{ar?'تحديث الحالة والقائمة':'Refresh status and queue'}</Button></div>
 <div role="status" className="text-sm">{message}{last&&<p className="mt-2">{ar?'آخر فحص: ':'Last check: '}{last.state==='checked'?(ar?'انتهى الفحص؛ راجع حالة كل عملية':'Check finished; inspect individual payment status'):last.state==='requested'?(ar?'طُلب، ولم يُثبت انتهاؤه بعد':'Requested; completion not yet confirmed'):(ar?'تعذر الفحص؛ الحراس محفوظون':'Unavailable; guards preserved')} · {new Date(last.finishedAt||last.requestedAt).toLocaleString()}</p>}</div>
 </section>
}
