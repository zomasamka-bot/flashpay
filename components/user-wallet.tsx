"use client"
import {useCallback,useEffect,useRef,useState} from 'react'
import {Eye,EyeOff,RefreshCw,Copy} from 'lucide-react'
import {useMerchant} from '@/lib/use-merchant'
import {useI18n} from '@/components/i18n-provider'
import {connectWalletDisplay,readWalletDisplay,saveWalletDisplay,type WalletDisplaySession,type WalletDisplayBalance} from '@/lib/wallet-display'
import {unifiedStore} from '@/lib/unified-store'
import {copyText} from '@/lib/browser-actions'
import {Button} from '@/components/ui/button'
export function UserWallet(){
 const merchant=useMerchant(),{t}=useI18n()
 const [shown,setShown]=useState(false),[value,setValue]=useState<WalletDisplayBalance|null>(null),[busy,setBusy]=useState(false),[copyFailed,setCopyFailed]=useState(false),[error,setError]=useState('')
 const [needsAddress,setNeedsAddress]=useState(false),[address,setAddress]=useState('')
 const pending=useRef<AbortController|null>(null),session=useRef<WalletDisplaySession|null>(null),generation=useRef(0),inFlight=useRef(false)
 const identity=merchant.verifiedUid||merchant.uid
 useEffect(()=>{generation.current++;pending.current?.abort();session.current=null;inFlight.current=false;setNeedsAddress(false);setAddress('');setShown(false);setValue(null);setBusy(false);setCopyFailed(false);setError('');return()=>{generation.current++;pending.current?.abort()}},[merchant.accessToken,identity])
 const refresh=useCallback(async(reconnect=false,saveAddress?:string)=>{
  if(inFlight.current)return
  pending.current?.abort();const controller=new AbortController();pending.current=controller
  const current=++generation.current;inFlight.current=true;setBusy(true);setError('')
  let timeout:ReturnType<typeof setTimeout>|undefined
  try{
   if(!identity||!merchant.accessToken)throw Error('AUTH_REQUIRED')
   let credentials=session.current??{uid:identity,accessToken:merchant.accessToken}
   if(reconnect)credentials=await connectWalletDisplay(identity)
   if(controller.signal.aborted||current!==generation.current)return
   session.current=credentials
   timeout=setTimeout(()=>controller.abort(),30_000)
   if(saveAddress!==undefined){
    try{await saveWalletDisplay(credentials,saveAddress,controller.signal)}catch(e){if(!(e instanceof Error&&e.message==='WALLET_ALREADY_SAVED'))throw e}
    if(controller.signal.aborted||current!==generation.current)return
    setNeedsAddress(false);setAddress('')
   }
   const result=await readWalletDisplay(credentials,controller.signal)
   if(controller.signal.aborted||current!==generation.current)return
   setNeedsAddress(result===null);setValue(result)
  }catch(e){if(current===generation.current){setValue(null);if(e instanceof Error&&e.message==='AUTH_REQUIRED')session.current=null;setError(controller.signal.aborted?'WALLET_UNAVAILABLE':e instanceof Error?e.message:'WALLET_UNAVAILABLE')}}
  finally{clearTimeout(timeout);if(current===generation.current){inFlight.current=false;setBusy(false)}}
 },[identity,merchant.accessToken])
 useEffect(()=>{
  if(!shown||!value)return
  const poll=()=>{if(document.visibilityState==='visible'&&!inFlight.current)void refresh()}
  const timer=setInterval(poll,15_000),unsubscribe=unifiedStore.subscribe('payments',poll)
  window.addEventListener('focus',poll);document.addEventListener('visibilitychange',poll)
  return()=>{unsubscribe();clearInterval(timer);window.removeEventListener('focus',poll);document.removeEventListener('visibilitychange',poll)}
 },[shown,Boolean(value),refresh])
 if(!merchant.accessToken||!identity)return null
 return <section className="mt-2 min-w-0 rounded-lg border p-3" aria-label={t('wallet.current')}>
  <div className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium">{t('wallet.current')}</span><span className="font-mono" dir="ltr">{shown?(value?`${value.balance} ${value.network==='Pi Testnet'?'Test-Pi':'Pi'}`:'—'):'••••••'}</span>
  <Button variant="ghost" size="icon" aria-label={t(shown?'wallet.hide':'wallet.show')} aria-pressed={shown} onClick={()=>{if(shown){inFlight.current=false;generation.current++;pending.current?.abort();setShown(false);setValue(null);setBusy(false)}else{setShown(true);void refresh()}}}>{shown?<EyeOff className="h-4 w-4"/>:<Eye className="h-4 w-4"/>}</Button>
  {shown&&<Button variant="ghost" size="icon" disabled={busy} aria-label={t('wallet.refresh')} onClick={()=>void refresh()}><RefreshCw className={`h-4 w-4 ${busy?'animate-spin':''}`}/></Button>}</div>
  {shown&&<div className="space-y-2 text-xs text-muted-foreground">
   <div role="status">{busy?t('wallet.loading'):error?t(error==='INVALID_ADDRESS'?'wallet.invalidAddress':error==='WALLET_NOT_ON_NETWORK'?'wallet.networkMissing':error==='AUTH_REQUIRED'?'wallet.signInAgain':'wallet.unavailable'):value&&<><p>{value.network} · {t('wallet.updated')} {new Date(value.asOf).toLocaleTimeString()}</p><p>{t('wallet.balanceNote')}</p></>}</div>
   {needsAddress&&<form className="space-y-2" onSubmit={e=>{e.preventDefault();void refresh(false,address.trim())}}>
    <label className="block"><span>{t('wallet.publicAddress')}</span><input aria-label={t('wallet.publicAddress')} className="mt-1 w-full min-w-0 rounded border bg-background p-2 text-sm text-foreground" dir="ltr" autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={56} required pattern="G[A-Z2-7]{55}" value={address} disabled={busy} onChange={e=>setAddress(e.target.value.trim())}/></label>
    <p>{t('wallet.saveOnceNote')}</p><Button type="submit" variant="outline" disabled={busy||!/^G[A-Z2-7]{55}$/.test(address)}>{t('wallet.saveOnce')}</Button>
   </form>}
   {value&&<div className="flex items-center gap-1"><input aria-label={t('wallet.address')} className="min-w-0 flex-1 bg-transparent text-xs" readOnly dir="ltr" value={value.address} onFocus={e=>e.currentTarget.select()}/><Button variant="ghost" size="icon" aria-label={t('wallet.copy')} onClick={async()=>setCopyFailed(!await copyText(value.address))}><Copy className="h-4 w-4"/></Button></div>}
   {copyFailed&&<p>{t('actions.manualCopy')}</p>}
   {error==='AUTH_REQUIRED'&&<Button variant="outline" disabled={busy} onClick={()=>void refresh(true)}>{t('wallet.reconnect')}</Button>}
  </div>}
 </section>
}
