import 'server-only'
import crypto from 'node:crypto'
import { acquirePiWalletSubmitLock } from './pi-wallet-submit-lock'
import { isRedisConfigured, redis } from './redis'

const PROCESS_ID=crypto.randomUUID()
const PREFIX='flashpay:cert:fin4:r4t:lock-probe:'
const SUBMIT_KEY_PREFIX='flashpay:wallet:submit:'

type SubmitLockDiagnostic =
  | {state:'free';ttlSeconds:-2}
  | {state:'busy';ttlSeconds:number}
  | {state:'unavailable';ttlSeconds:null;errorCode:'NOT_CONFIGURED'|'INVALID_SOURCE_WALLET'|'REDIS_EVAL_FAILED'|'MALFORMED_DIAGNOSTIC'}

const SUBMIT_LOCK_DIAGNOSTIC_SCRIPT=`
local exists = redis.call('EXISTS', KEYS[1])
local ttl = redis.call('TTL', KEYS[1])
return {exists, ttl}
`

function requestId(){return crypto.randomUUID()}
function submitKey(sourceWallet:string){return `${SUBMIT_KEY_PREFIX}${sourceWallet}`}
export function fin4R4TProbeProcessId(){return PROCESS_ID}

export async function readFin4R4TSubmitLockDiagnostic(sourceWallet:string):Promise<SubmitLockDiagnostic>{
  if(!isRedisConfigured) return {state:'unavailable',ttlSeconds:null,errorCode:'NOT_CONFIGURED'}
  if(!sourceWallet||sourceWallet!==sourceWallet.trim()) return {state:'unavailable',ttlSeconds:null,errorCode:'INVALID_SOURCE_WALLET'}
  try{
    const result=await redis.eval<[], [number,number]>(SUBMIT_LOCK_DIAGNOSTIC_SCRIPT,[submitKey(sourceWallet)],[])
    if(!Array.isArray(result)||result.length!==2||!Number.isInteger(result[0])||!Number.isInteger(result[1])) return {state:'unavailable',ttlSeconds:null,errorCode:'MALFORMED_DIAGNOSTIC'}
    const [exists,ttl]=result
    if(exists===0&&ttl===-2) return {state:'free',ttlSeconds:-2}
    if(exists===1&&ttl>=-1) return {state:'busy',ttlSeconds:ttl}
    return {state:'unavailable',ttlSeconds:null,errorCode:'MALFORMED_DIAGNOSTIC'}
  }catch{return {state:'unavailable',ttlSeconds:null,errorCode:'REDIS_EVAL_FAILED'}}
}

export async function holdFin4R4TWalletProbe(runId:string,sourceWallet:string){
  const probeRequestId=requestId()
  const before=await readFin4R4TSubmitLockDiagnostic(sourceWallet)
  if(before.state==='unavailable') return {ok:false,processId:PROCESS_ID,requestId:probeRequestId,reason:'LOCK_DIAGNOSTIC_UNAVAILABLE',lockDiagnostic:before,financialMovementExecuted:false}
  if(before.state==='busy') return {ok:false,processId:PROCESS_ID,requestId:probeRequestId,reason:'BUSY_PRODUCTION_LOCK',lockDiagnostic:before,financialMovementExecuted:false}
  const lock=await acquirePiWalletSubmitLock(sourceWallet)
  if(!lock){
    const raced=await readFin4R4TSubmitLockDiagnostic(sourceWallet)
    return {ok:false,processId:PROCESS_ID,requestId:probeRequestId,reason:'LOCK_RACED_BUSY',lockDiagnostic:raced,financialMovementExecuted:false}
  }
  const nonce=crypto.randomUUID(); const key=`${PREFIX}${runId}:held`
  try{
    await redis.set(key,JSON.stringify({nonce,processId:PROCESS_ID,requestId:probeRequestId}),{ex:15})
    const deadline=Date.now()+8000
    while(Date.now()<deadline){ const release=await redis.get<string>(`${PREFIX}${runId}:release`); if(release===nonce) break; await new Promise(r=>setTimeout(r,50)) }
    return {ok:true,processId:PROCESS_ID,requestId:probeRequestId,nonce,lockDiagnosticBefore:before,financialMovementExecuted:false}
  } finally { await lock.release(); try{await redis.del(key)}catch{} }
}

export async function contendFin4R4TWalletProbe(runId:string,sourceWallet:string){
  const probeRequestId=requestId()
  const held=await readFin4R4THeld(runId)
  const before=await readFin4R4TSubmitLockDiagnostic(sourceWallet)
  const lock=await acquirePiWalletSubmitLock(sourceWallet)
  if(!lock) return {acquired:false,processId:PROCESS_ID,requestId:probeRequestId,heldOwner:held,lockDiagnostic:before,financialMovementExecuted:false}
  await lock.release()
  return {acquired:true,processId:PROCESS_ID,requestId:probeRequestId,heldOwner:held,lockDiagnostic:before,financialMovementExecuted:false}
}
export async function readFin4R4THeld(runId:string){try{const raw=await redis.get<string>(`${PREFIX}${runId}:held`);return raw?JSON.parse(raw):null}catch{return null}}
export async function releaseFin4R4THolder(runId:string,nonce:string){try{await redis.set(`${PREFIX}${runId}:release`,nonce,{ex:15});return true}catch{return false}}
