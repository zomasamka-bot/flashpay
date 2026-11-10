import 'server-only'
import {redis} from './redis'
import {ensurePrivateTrustHost} from './r36-private-host-wake'

type Ports={env:NodeJS.ProcessEnv;claim:()=>Promise<unknown>;wake:()=>Promise<boolean>}
/** Best-effort operational preparation after verified login. Never admission. */
export async function prewarmAfterVerifiedLogin(ports:Ports):Promise<void>{
 if(ports.env.VERCEL_ENV!=='production'||ports.env.R36_HOST_MODE!=='vercel_on_demand')return
 try{if(await ports.claim()!=='OK')return;await ports.wake()}catch{/* Login and financial guards remain independent. */}
}
export const prewarmVerifiedSession=()=>prewarmAfterVerifiedLogin({env:process.env,
 claim:()=>redis.set('flashpay:r36:verified-login-prewarm:v1','1',{nx:true,ex:180}),
 wake:()=>ensurePrivateTrustHost('creation')})
