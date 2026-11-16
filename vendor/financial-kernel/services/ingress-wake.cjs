"use strict";
// A boot-bound monotonic operational ticket. Contains no identity, credential,
// wallet, transaction or permission. Caller holds the host's exclusive flock.
const fs=require('node:fs'),path=require('node:path');
function issueIngressTicket(root='/run/flashpay-r36'){
 const boot=JSON.parse(fs.readFileSync(path.join(root,'boot.json'),'utf8'));
 if(!/^[a-f0-9-]{36}$/.test(boot.id))throw Error('INGRESS_BOOT_ID');
 const directory=path.join(root,'ingress');fs.mkdirSync(directory,{recursive:true,mode:0o755});
 const stat=fs.lstatSync(directory);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('INGRESS_DIRECTORY');
 const target=path.join(directory,'state.json');let previous=null;
 try{const fd=fs.openSync(target,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const st=fs.fstatSync(fd);if(!st.isFile()||st.size>1024)throw Error('INGRESS_STATE');previous=JSON.parse(fs.readFileSync(fd,'utf8'))}finally{fs.closeSync(fd)}}catch(e){if(e.code!=='ENOENT')throw e}
 if(previous&&(previous.bootId!==boot.id||!Number.isSafeInteger(previous.generation)||previous.generation<0))throw Error('INGRESS_GENERATION');
 const generation=(previous?.generation??0)+1;if(!Number.isSafeInteger(generation))throw Error('INGRESS_GENERATION');
 const ticket={bootId:boot.id,generation},temp=target+'.'+process.pid+'.tmp';
 const fd=fs.openSync(temp,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY,0o644);
 try{fs.writeFileSync(fd,JSON.stringify(ticket));fs.fsyncSync(fd)}finally{fs.closeSync(fd)}fs.renameSync(temp,target);
 return ticket;
}
function readIngressTicket(file){
 if(!file)return null;
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size>1024)throw Error('INGRESS_STATE');const x=JSON.parse(fs.readFileSync(fd,'utf8'));if(!/^[a-f0-9-]{36}$/.test(x.bootId)||!Number.isSafeInteger(x.generation)||x.generation<1)throw Error('INGRESS_GENERATION');return x}finally{fs.closeSync(fd)}
}
module.exports={issueIngressTicket,readIngressTicket};
if(require.main===module)console.log(JSON.stringify(issueIngressTicket()));
