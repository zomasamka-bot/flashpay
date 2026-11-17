export async function readLimitedText(request:Request,limit:number):Promise<string>{
 if(Number(request.headers.get("content-length"))>limit)throw new Error("REQUEST_TOO_LARGE")
 const reader=request.body?.getReader();if(!reader)return ""
 const parts:Uint8Array[]=[];let total=0
 try{for(;;){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>limit){await reader.cancel();throw new Error("REQUEST_TOO_LARGE")}parts.push(value)}}finally{reader.releaseLock()}
 const bytes=new Uint8Array(total);let offset=0;for(const p of parts){bytes.set(p,offset);offset+=p.length}
 return new TextDecoder("utf-8",{fatal:true}).decode(bytes)
}
