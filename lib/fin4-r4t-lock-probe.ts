import 'server-only'
import crypto from 'node:crypto'
import { acquirePiWalletSubmitLock } from './pi-wallet-submit-lock'
import { isRedisConfigured, redis } from './redis'

const PROCESS_ID=crypto.randomUUID()
const PREFIX='flashpay:cert:fin4:r4t:lock-probe:'
export function fin4R4TProbeProcessId(){return PROCESS_ID}
export async function holdFin4R4TWalletProbe(runId:string,sourceWallet:string){
  if(!isRedisConfigured) return {ok:false,processId:PROCESS_ID,reason:'redis_unavailable'}
  const lock=await acquirePiWalletSubmitLock(sourceWallet)
  if(!lock) return {ok:false,processId:PROCESS_ID,reason:'lock_not_acquired'}
  const nonce=crypto.randomUUID(); const key=`${PREFIX}${runId}:held`
  try{
    await redis.set(key,JSON.stringify({nonce,processId:PROCESS_ID}),{ex:15})
    const deadline=Date.now()+8000
    while(Date.now()<deadline){ const release=await redis.get<string>(`${PREFIX}${runId}:release`); if(release===nonce) break; await new Promise(r=>setTimeout(r,50)) }
    return {ok:true,processId:PROCESS_ID,nonce,financialMovementExecuted:false}
  } finally { await lock.release(); try{await redis.del(key)}catch{} }
}
export async function contendFin4R4TWalletProbe(sourceWallet:string){
  const lock=await acquirePiWalletSubmitLock(sourceWallet)
  if(!lock) return {acquired:false,processId:PROCESS_ID,financialMovementExecuted:false}
  await lock.release(); return {acquired:true,processId:PROCESS_ID,financialMovementExecuted:false}
}
export async function readFin4R4THeld(runId:string){try{const raw=await redis.get<string>(`${PREFIX}${runId}:held`);return raw?JSON.parse(raw):null}catch{return null}}
export async function releaseFin4R4THolder(runId:string,nonce:string){try{await redis.set(`${PREFIX}${runId}:release`,nonce,{ex:15});return true}catch{return false}}
