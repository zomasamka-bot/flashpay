'use strict';
const fs=require('node:fs'),cp=require('node:child_process'),path=require('node:path');
// Linux cannot reopen Node's socket-backed extra stdio as /dev/fd/N.
// OpenSSL inputs therefore use private, RAM-backed files, removed after each call.
async function runTls(args,extras,input){
 const root='/run/flashpay-r36';
 if(Number(fs.statfsSync(root).type)!==0x01021994)throw Error('TLS_RAM_STORAGE_REQUIRED');
 const dir=fs.mkdtempSync(path.join(root,'tls-'));fs.chmodSync(dir,0o700);
 try{
  const paths=extras.map((value,i)=>{const p=path.join(dir,String(i));fs.writeFileSync(p,value,{mode:0o600,flag:'wx'});return p});
  const actual=args.map(a=>/^\/dev\/fd\/[3-9]$/.test(a)?paths[Number(a.slice(8))-3]:a);
  if(actual.some(a=>typeof a!=='string'))throw Error('TLS_INPUT_SCOPE');
  return await new Promise((resolve,reject)=>{
   const p=cp.spawn('/usr/bin/openssl',actual,{stdio:['pipe','pipe','pipe']});const chunks=[];let size=0;
   const timer=setTimeout(()=>{p.kill('SIGKILL');reject(Error('TLS_RENEWAL_TIMEOUT'))},10000);
   p.stdout.on('data',b=>{size+=b.length;if(size>64000){p.kill('SIGKILL');reject(Error('TLS_OUTPUT_LIMIT'))}else chunks.push(b)});
   p.stderr.resume();p.on('error',()=>{clearTimeout(timer);reject(Error('TLS_RENEWAL_FAILED'))});
   p.on('close',code=>{clearTimeout(timer);code===0?resolve(Buffer.concat(chunks).toString()):reject(Error('TLS_RENEWAL_FAILED'))});
   p.stdin.on('error',()=>{});p.stdin.end(input);
  });
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
}
module.exports={runTls};
