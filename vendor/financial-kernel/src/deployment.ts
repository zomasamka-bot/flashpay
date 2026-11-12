import {createHash} from 'node:crypto'
import {assertActiveNetworkConfiguration} from './lib/active-financial-contract'
/** This configuration pins deployment identity. It never grants a financial right.
 * One process/database/Redis/wallet per application. No runtime tenant switching.
 */
export type KernelDeployment = Readonly<{
 schema:'KERNEL_DEPLOYMENT_V1'; applicationId:string; piApplicationId:string;
 network:'Pi Testnet'; databaseHost:string; databaseName:string; databaseBranch:string;
 publicOrigin:string; trustOrigin:string; redisOrigin:string; sourceWallet:string;
 recoveryCutover:string; historicalHolds:readonly string[];
}>
const fields=['schema','applicationId','piApplicationId','network','databaseHost','databaseName','databaseBranch','publicOrigin','trustOrigin','redisOrigin','sourceWallet','recoveryCutover','historicalHolds'].sort().join(',')
const digest=(s:string)=>createHash('sha256').update(s).digest('hex')
function origin(v:unknown):boolean {try {const u=new URL(String(v));return u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash&&u.origin===v}catch{return false}}
export function validateDeployment(raw:string,expectedSha256:string):KernelDeployment {
 if(raw.length>16384||!/^[a-f0-9]{64}$/.test(expectedSha256)||digest(raw)!==expectedSha256)throw Error('KERNEL_PROFILE_DIGEST')
 const p=JSON.parse(raw)
 if(!p||typeof p!=='object'||Object.keys(p).sort().join(',')!==fields||p.schema!=='KERNEL_DEPLOYMENT_V1'||p.network!=='Pi Testnet')throw Error('KERNEL_PROFILE_FIELDS')
 if(!/^[a-z][a-z0-9-]{2,79}$/.test(p.applicationId)||!/^[a-z][a-z0-9-]{2,127}$/.test(p.piApplicationId)||
 !/^[a-z0-9][a-z0-9.-]{0,252}$/.test(p.databaseHost)||p.databaseHost.includes('..')||p.databaseHost.includes('-pooler.')||
 !/^[a-z][a-z0-9_]{0,62}$/.test(p.databaseName)||!/^[a-z][a-z0-9-]{2,127}$/.test(p.databaseBranch)||
 !origin(p.publicOrigin)||!origin(p.trustOrigin)||!origin(p.redisOrigin)||p.publicOrigin===p.trustOrigin||
 !/^G[A-Z2-7]{55}$/.test(p.sourceWallet)||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(p.recoveryCutover)||!Number.isFinite(Date.parse(p.recoveryCutover))||
 !Array.isArray(p.historicalHolds)||p.historicalHolds.length>10000||p.historicalHolds.some((x:unknown)=>typeof x!=='string'||!/^[a-f0-9]{64}$/.test(x))||new Set(p.historicalHolds).size!==p.historicalHolds.length)throw Error('KERNEL_PROFILE_IDENTITY')
 Object.freeze(p.historicalHolds);return Object.freeze(p)
}
let cached:{raw:string;hash:string;profile:KernelDeployment}|undefined
export function deployment():KernelDeployment {
 const raw=process.env.KERNEL_DEPLOYMENT_PROFILE??'',hash=process.env.KERNEL_DEPLOYMENT_SHA256??''
 if(cached){if(raw!==cached.raw||hash!==cached.hash)throw Error('KERNEL_PROFILE_CHANGED');return cached.profile}
 const profile=validateDeployment(raw,hash);cached={raw,hash,profile};return profile
}
export function verifyDatabaseUrl(value:string,role?:string):void {
 const p=deployment(),u=new URL(value)
 if(u.protocol!=='postgresql:'||u.hostname.replace('-pooler.','.')!==p.databaseHost||u.pathname!=='/'+p.databaseName||
 (u.port&&u.port!=='5432')||!u.username||!u.password||u.hash||(role&&u.username!==role)||
 [...u.searchParams].some(([k,v])=>!(k==='sslmode'&&['require','verify-full'].includes(v)||k==='channel_binding'&&v==='require')))throw Error('KERNEL_DATABASE_TARGET')
}
export function verifyEnvironment():void {
 const p=deployment()
 assertActiveNetworkConfiguration(p.network,process.env.NEXT_PUBLIC_PI_NETWORK)
 for(const [key,expected] of [['UPSTASH_REDIS_REST_URL',p.redisOrigin],['R36_HOST_ORIGIN',p.trustOrigin],['NEXT_PUBLIC_APP_URL',p.publicOrigin],['PI_ACTIVE_WALLET_ADDRESS',p.sourceWallet]]) {
  const actual=process.env[key];if(actual&&actual!==expected)throw Error('KERNEL_ENVIRONMENT_IDENTITY:'+key)
 }
 if(process.env.DATABASE_URL)verifyDatabaseUrl(process.env.DATABASE_URL)
 if(process.env.R36_RUNTIME_DATABASE_URL)verifyDatabaseUrl(process.env.R36_RUNTIME_DATABASE_URL,'r36_runtime')
}
export async function verifyDatabaseBinding(db:{unsafe(query:string,values:never):PromiseLike<unknown[]>}):Promise<void>{
 const p=deployment(),rows=await db.unsafe(`SELECT application_id,profile_sha256,current_database() AS database,
 current_setting('neon.branch_id',true) AS branch FROM public.kernel_deployment_identity WHERE singleton=true`,[] as never)
 const r=rows.length===1?rows[0] as Record<string,unknown>:null
 if(!r||r.application_id!==p.applicationId||r.profile_sha256!==process.env.KERNEL_DEPLOYMENT_SHA256||r.database!==p.databaseName||r.branch!==p.databaseBranch)throw Error('KERNEL_DATABASE_BINDING')
}
