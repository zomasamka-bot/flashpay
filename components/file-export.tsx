"use client"
import {useEffect,useState,useRef} from "react"
import {useI18n} from "@/components/i18n-provider"
import {useMerchant} from "@/lib/use-merchant"
import {Button} from "@/components/ui/button"
import {copyText,downloadFile,isShareCancelled,openExternalUrl} from "@/lib/browser-actions"
export function useFileExport(){
 const {t}=useI18n(),merchant=useMerchant()
 const [busy,setBusy]=useState(false),[link,setLink]=useState<string|null>(null),[error,setError]=useState("")
 const active=useRef(false),generation=useRef(0)
 useEffect(()=>{generation.current++;active.current=false;setBusy(false);setLink(null);setError("");return()=>{generation.current++}},[merchant.accessToken])
 const exportFile=async(file:File,title:string)=>{
  if(active.current)return;active.current=true;const turn=generation.current;setBusy(true);setLink(null);setError("")
  try{
   // This call remains within the originating tap. No await before native sharing.
   let canShareFile=false
   try{canShareFile=typeof navigator.share==='function'&&(!navigator.canShare||navigator.canShare({files:[file]}))}catch{/* Restricted WebViews may throw during capability detection. */}
   if(canShareFile){
    try{await navigator.share({files:[file],title});return}catch(e){if(isShareCancelled(e))return}
   }
   if(!/Android|PiBrowser/i.test(navigator.userAgent)){downloadFile(file);return}
   const response=await fetch('/api/merchant/export',{method:'POST',headers:{Authorization:`Bearer ${merchant.accessToken}`,'Content-Type':'text/csv; charset=utf-8'},body:file})
   const result=await response.json()
   if(!response.ok||typeof result.url!=='string'||new URL(result.url).origin!==location.origin)throw new Error('EXPORT_UNAVAILABLE')
   if(turn===generation.current)setLink(result.url)
  }catch{if(turn===generation.current)setError(t('export.failed'))}
  finally{if(turn===generation.current){setBusy(false);active.current=false}}
 }
 const exportPanel=(link||error||busy)?<div className="my-3 space-y-2 rounded-lg border p-3 text-sm" role="status">
  {busy&&<p>{t('export.preparing')}</p>}{error&&<p className="text-destructive">{error}</p>}
  {link&&<><p>{t('export.ready')}</p><div className="flex flex-wrap gap-2">
   <Button onClick={()=>void openExternalUrl(link).catch(()=>setError(t('export.openFailed')))}>{t('export.open')}</Button>
   <Button variant="outline" onClick={async()=>{try{const pi=window.Pi as typeof window.Pi&{openShareDialog?:(title:string,message:string)=>void};if(pi?.openShareDialog){pi.openShareDialog(t('transactions.export'),link);return}if(navigator.share){await navigator.share({title:t('transactions.export'),url:link});return}if(!await copyText(link))setError(t('actions.manualCopy'))}catch(e){if(!isShareCancelled(e))setError(t('actions.manualCopy'))}}}>{t('export.share')}</Button>
   <Button variant="outline" onClick={async()=>{if(!await copyText(link))setError(t('actions.manualCopy'))}}>{t('export.copy')}</Button>
  </div><input readOnly dir="ltr" className="w-full rounded border bg-transparent p-2 text-xs" aria-label={t('export.link')} value={link} onFocus={e=>e.currentTarget.select()}/></>}
 </div>:null
 return {exportFile,exportPanel,exportBusy:busy}
}
