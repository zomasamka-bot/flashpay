'use strict';
// Host-only adapter. systemd decrypts each credential into its private runtime
// directory; values are delivered only to the appropriate child over stdin.
const fs=require('node:fs'),path=require('node:path');
const NAMES=Object.freeze([
 'tls-ca','issuer','signer','evidence-server','controller','tls-registrar',
 'tls-producer','tls-provider','evidence-custodian','custody-decryption',
 'r36_issuer','r36_signer','r36_registrar','r36_evidence_reader','pi-provider','recovery'
]);
function createCredentialReader(directory){
 if(typeof directory!=='string'||!path.isAbsolute(directory))throw Error('CREDENTIAL_DIRECTORY_REQUIRED');
 const base=fs.realpathSync(directory),s=fs.lstatSync(directory);
 if(base!==directory||!s.isDirectory()||s.isSymbolicLink()||(s.mode&0o077)!==0||s.uid!==process.getuid())throw Error('CREDENTIAL_DIRECTORY_NOT_PRIVATE');
 return function read(name){
  if(!NAMES.includes(name))throw Error('CREDENTIAL_NAME_NOT_ALLOWED');
  const file=path.join(base,name),fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{
   const st=fs.fstatSync(fd);
   if(!st.isFile()||(st.mode&0o077)!==0||st.uid!==process.getuid()||st.nlink!==1||st.size<2||st.size>64000)throw Error('CREDENTIAL_STORAGE_NOT_PRIVATE');
   const value=JSON.parse(fs.readFileSync(fd,'utf8'));
   if(!value||typeof value!=='object'||Array.isArray(value))throw Error('CREDENTIAL_FORMAT');
   return value;
  }finally{fs.closeSync(fd)}
 };
}
module.exports={NAMES,createCredentialReader};
