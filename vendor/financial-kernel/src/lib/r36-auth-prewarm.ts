import 'server-only'
import {redis} from './redis'
import {ensurePrivateTrustHost} from './r36-private-host-wake'
import {observeIntakePolicy} from './r36-intake-observation'

type Ports={env:NodeJS.ProcessEnv;claim:()=>Promise<unknown>;wake:()=>Promise<boolean>}
/** Best-effort operational preparation after verified login. Never admission. */
export async function prewarmAfterVerifiedLogin(ports:Ports):Promise<void>{
 if(ports.env.VERCEL_ENV!=='production'||ports.env.R36_HOST_MODE!=='vercel_on_demand')return
 try{if(await ports.claim()!=='OK')return;await ports.wake()}catch{/* Login and financial guards remain independent. */}
}
export const prewarmVerifiedSession=async()=>{
 // The registry observation lasts at most 120s. Its lightweight refresh must
 // not inherit a host-start throttle as long as the host's own renewal window.
 // Both preparations remain bounded by verified activity, never an idle timer.
 await Promise.all([prewarmAfterVerifiedLogin({env:process.env,
  claim:()=>redis.set('flashpay:r36:verified-intake-prewarm:v1','1',{nx:true,ex:60}),
  wake:()=>observeIntakePolicy()}),
 prewarmAfterVerifiedLogin({env:process.env,
  claim:()=>redis.set('flashpay:r36:verified-login-prewarm:v2','1',{nx:true,ex:60}),
  wake:()=>ensurePrivateTrustHost('creation')})])
}
