import 'server-only'

type Ports={reserve:()=>Promise<string|null>;wake:()=>Promise<boolean>;prepare:()=>void}
/** SQL admission, including revocation and wallet activation, is authoritative.
 * Reuse the exact reservation identity after renewal; never mint a replacement.
 * A wake is operational readiness, not authority to create or send money. */
export async function reserveWithCurrentEvidence(p:Ports):Promise<{id:string|null;path:'current'|'renewed'|'held'}>{
 const current=await p.reserve()
 if(current){p.prepare();return {id:current,path:'current'}}
 if(!await p.wake())return {id:null,path:'held'}
 const renewed=await p.reserve()
 if(renewed)p.prepare()
 return {id:renewed,path:renewed?'renewed':'held'}
}
