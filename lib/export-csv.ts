export function csvCell(cell:unknown):string{
 let value=cell==null?"":String(cell)
 if(/^[\s\u0000-\u001f]*[=+@-]/.test(value)||/^[\t\r\n]/.test(value))value="'"+value
 return '"'+value.replace(/"/g,'""')+'"'
}
// Accept only the quoted CSV emitted by our export UI; never serve HTML or script.
export function safeExportCsv(text:string):string{
 const rows:string[][]=[];let row:string[]=[],pos=text.charCodeAt(0)===0xfeff?1:0
 const cell=/"((?:[^"\u0000]|"")*)"/gy
 while(pos<text.length){
  cell.lastIndex=pos;const match=cell.exec(text);if(!match)throw new Error("INVALID_CSV")
  row.push(match[1].replace(/""/g,'"'));if(row.length>32)throw new Error("INVALID_CSV")
  pos=cell.lastIndex
  if(text[pos]===','){pos++;if(pos===text.length)throw new Error("INVALID_CSV");continue}
  rows.push(row);row=[];if(rows.length>1001)throw new Error("INVALID_CSV")
  if(pos===text.length)break
  if(text.slice(pos,pos+2)!=='\r\n')throw new Error("INVALID_CSV");pos+=2
 }
 if(!rows.length||rows.some(r=>r.length!==rows[0].length))throw new Error("INVALID_CSV")
 return "\uFEFF"+rows.map(r=>r.map(csvCell).join(',')).join('\r\n')
}
