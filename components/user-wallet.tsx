"use client"
import {useEffect,useRef,useState} from "react"
import {Eye,EyeOff,RefreshCw,Copy} from "lucide-react"
import {useMerchant} from "@/lib/use-merchant"
import {useI18n} from "@/components/i18n-provider"
import {authenticateMerchant} from "@/lib/pi-sdk"
import {copyText} from "@/lib/browser-actions"
import {Button} from "@/components/ui/button"
type Balance={uid:string;address:string;balance:string;network:string;asOf:string}
export function UserWallet(){
 const merchant=useMerchant(),{t}=useI18n()
 const [shown,setShown]=useState(false),[value,setValue]=useState<Balance|null>(null),[busy,setBusy]=useState(false),[copyFailed,setCopyFailed]=useState(false),[error,setError]=useState("")
 const pending=useRef<AbortController|null>(null)
 const identity=merchant.verifiedUid||merchant.uid
 useEffect(()=>{pending.current?.abort();setShown(false);setValue(null);setBusy(false);setCopyFailed(false);setError("");return()=>pending.current?.abort()},[merchant.accessToken,identity])
 const refresh=async()=>{
  pending.current?.abort();const controller=new AbortController();pending.current=controller;setBusy(true);setValue(null);setError("")
  try{
   const r=await fetch("/api/wallet/balance",{headers:{Authorization:`Bearer ${merchant.accessToken}`},cache:"no-store",signal:controller.signal}),d=await r.json()
   if(!r.ok)throw new Error(d.error||"WALLET_UNAVAILABLE")
   if(d.uid!==identity)throw new Error("AUTH_REQUIRED")
   if(!controller.signal.aborted)setValue(d)
  }catch(e){if(!controller.signal.aborted)setError(e instanceof Error?e.message:"WALLET_UNAVAILABLE")}
  finally{if(!controller.signal.aborted)setBusy(false)}
 }
 if(!merchant.accessToken||!identity)return null
 return <section className="mt-2 min-w-0 rounded-lg border p-3" aria-label={t("wallet.current")}>
  <div className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium">{t("wallet.current")}</span><span className="font-mono" dir="ltr">{shown?(value?`${value.balance} π`:"—"):"••••••"}</span>
  <Button variant="ghost" size="icon" aria-label={t(shown?"wallet.hide":"wallet.show")} aria-pressed={shown} onClick={()=>{if(shown){pending.current?.abort();setShown(false);setValue(null);setBusy(false)}else{setShown(true);void refresh()}}}>{shown?<EyeOff className="h-4 w-4"/>:<Eye className="h-4 w-4"/>}</Button>
  {shown&&<Button variant="ghost" size="icon" disabled={busy} aria-label={t("wallet.refresh")} onClick={()=>void refresh()}><RefreshCw className={`h-4 w-4 ${busy?"animate-spin":""}`}/></Button>}</div>
  {shown&&<div className="space-y-1 text-xs text-muted-foreground" role="status">{busy?t("wallet.loading"):error?t(error==="WALLET_PERMISSION_REQUIRED"?"wallet.permission":error==="WALLET_NOT_ON_NETWORK"?"wallet.networkMissing":"wallet.unavailable"):value&&<>
   <p>{value.network} · {t("wallet.updated")} {new Date(value.asOf).toLocaleTimeString()}</p><p>{t("wallet.balanceNote")}</p>
   <div className="flex items-center gap-1"><input aria-label={t("wallet.address")} className="min-w-0 flex-1 bg-transparent text-xs" readOnly dir="ltr" value={value.address} onFocus={e=>e.currentTarget.select()}/><Button variant="ghost" size="icon" aria-label={t("wallet.copy")} onClick={async()=>setCopyFailed(!await copyText(value.address))}><Copy className="h-4 w-4"/></Button></div>
  </>}{copyFailed&&<p>{t("actions.manualCopy")}</p>}{(error==="WALLET_PERMISSION_REQUIRED"||error==="AUTH_REQUIRED")&&<Button variant="outline" disabled={busy} onClick={async()=>{setBusy(true);try{const result=await authenticateMerchant();if(!result.success)setError("WALLET_UNAVAILABLE")}finally{setBusy(false)}}}>{t("wallet.reconnect")}</Button>}</div>}
 </section>
}
