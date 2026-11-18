"use client"
import {useCallback,useEffect,useRef,useState} from "react"
import {Eye,EyeOff,RefreshCw,Copy} from "lucide-react"
import {useMerchant} from "@/lib/use-merchant"
import {useI18n} from "@/components/i18n-provider"
import {connectWalletDisplay,readWalletDisplay,WalletSelectionRequired,type WalletDisplaySession} from "@/lib/wallet-display"
import {unifiedStore} from "@/lib/unified-store"
import {copyText} from "@/lib/browser-actions"
import {Button} from "@/components/ui/button"
type Balance={uid:string;address:string;balance:string;network:string;asOf:string}
export function UserWallet(){
 const merchant=useMerchant(),{t}=useI18n()
 const [shown,setShown]=useState(false),[value,setValue]=useState<Balance|null>(null),[busy,setBusy]=useState(false),[copyFailed,setCopyFailed]=useState(false),[error,setError]=useState("")
 const [choices,setChoices]=useState<string[]>([])
 const pending=useRef<AbortController|null>(null),session=useRef<WalletDisplaySession|null>(null),generation=useRef(0),inFlight=useRef(false)
 const identity=merchant.verifiedUid||merchant.uid
 useEffect(()=>{generation.current++;pending.current?.abort();session.current=null;inFlight.current=false;setChoices([]);setShown(false);setValue(null);setBusy(false);setCopyFailed(false);setError("");return()=>{generation.current++;pending.current?.abort()}},[merchant.accessToken,identity])
 const refresh=useCallback(async(reconnect=false,selectedAddress?:string)=>{
  pending.current?.abort();const controller=new AbortController();pending.current=controller
  const current=++generation.current;inFlight.current=true;setBusy(true);setError("")
  let timeout:ReturnType<typeof setTimeout>|undefined
  try{
   if(!identity||!merchant.accessToken)throw Error('AUTH_REQUIRED')
   let credentials=session.current??{uid:identity,address:merchant.walletAddress||'',accessToken:merchant.accessToken}
   if(reconnect)credentials=await connectWalletDisplay(identity)
   if(controller.signal.aborted||current!==generation.current)return
   if(selectedAddress)credentials={...credentials,address:selectedAddress}
   // Keep the consented token for a retry even if a later read is temporarily unavailable.
   session.current=credentials
   timeout=setTimeout(()=>controller.abort(),20_000)
   const balance=await readWalletDisplay(credentials,controller.signal)
   if(controller.signal.aborted||current!==generation.current)return
   session.current={...credentials,address:balance.address};setChoices([]);setValue(balance)
  }catch(e){if(current===generation.current){setValue(null);setChoices(e instanceof WalletSelectionRequired?e.addresses:[]);if(e instanceof Error&&e.message==='AUTH_REQUIRED')session.current=null;setError(controller.signal.aborted?'WALLET_UNAVAILABLE':e instanceof Error?e.message:'WALLET_UNAVAILABLE')}}
  finally{clearTimeout(timeout);if(current===generation.current){inFlight.current=false;setBusy(false)}}
 },[identity,merchant.accessToken,merchant.walletAddress])
 useEffect(()=>{
  if(!shown||!value)return
  const poll=()=>{if(document.visibilityState==='visible'&&!inFlight.current&&!pending.current?.signal.aborted)void refresh()}
  const timer=setInterval(poll,15_000)
  const unsubscribe=unifiedStore.subscribe('payments',poll)
  window.addEventListener('focus',poll);document.addEventListener('visibilitychange',poll)
  return()=>{unsubscribe();clearInterval(timer);window.removeEventListener('focus',poll);document.removeEventListener('visibilitychange',poll)}
 },[shown,Boolean(value),refresh])
 if(!merchant.accessToken||!identity)return null
 return <section className="mt-2 min-w-0 rounded-lg border p-3" aria-label={t("wallet.current")}>
  <div className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium">{t("wallet.current")}</span><span className="font-mono" dir="ltr">{shown?(value?`${value.balance} ${value.network==='Pi Testnet'?'Test-Pi':'Pi'}`:"—"):"••••••"}</span>
  <Button variant="ghost" size="icon" aria-label={t(shown?"wallet.hide":"wallet.show")} aria-pressed={shown} onClick={()=>{if(shown){inFlight.current=false;generation.current++;pending.current?.abort();setShown(false);setValue(null);setBusy(false)}else{setShown(true);void refresh()}}}>{shown?<EyeOff className="h-4 w-4"/>:<Eye className="h-4 w-4"/>}</Button>
  {shown&&<Button variant="ghost" size="icon" disabled={busy} aria-label={t("wallet.refresh")} onClick={()=>void refresh()}><RefreshCw className={`h-4 w-4 ${busy?"animate-spin":""}`}/></Button>}</div>
  {shown&&<div className="space-y-1 text-xs text-muted-foreground" role="status">{busy?t("wallet.loading"):error?t(error==="WALLET_PERMISSION_REQUIRED"?"wallet.permission":error==="WALLET_NOT_ON_NETWORK"?"wallet.networkMissing":error==="WALLET_SELECTION_REQUIRED"?"wallet.select":error==="WALLET_APP_UNAUTHORIZED"?"wallet.appUnauthorized":error==="WALLET_SDK_UNAVAILABLE"?"wallet.sdkUnavailable":error==="WALLET_ADDRESS_UNAVAILABLE"?"wallet.addressUnavailable":"wallet.unavailable"):value&&<>
   <p>{value.network} · {t("wallet.updated")} {new Date(value.asOf).toLocaleTimeString()}</p><p>{t("wallet.balanceNote")}</p>
   <div className="flex items-center gap-1"><input aria-label={t("wallet.address")} className="min-w-0 flex-1 bg-transparent text-xs" readOnly dir="ltr" value={value.address} onFocus={e=>e.currentTarget.select()}/><Button variant="ghost" size="icon" aria-label={t("wallet.copy")} onClick={async()=>setCopyFailed(!await copyText(value.address))}><Copy className="h-4 w-4"/></Button></div>
  </>}{choices.length>1&&<select aria-label={t("wallet.select")} disabled={busy} value="" className="max-w-full rounded border bg-background p-2" onChange={e=>void refresh(false,e.target.value)}><option value="" disabled>{t("wallet.select")}</option>{choices.map(address=><option key={address} value={address}>{address}</option>)}</select>}{copyFailed&&<p>{t("actions.manualCopy")}</p>}{(error==="WALLET_PERMISSION_REQUIRED"||error==="AUTH_REQUIRED"||error==="WALLET_ADDRESS_UNAVAILABLE")&&<Button variant="outline" disabled={busy} onClick={()=>void refresh(true)}>{t("wallet.reconnect")}</Button>}</div>}
 </section>
}
