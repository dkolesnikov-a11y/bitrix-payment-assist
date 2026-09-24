// Auxiliary matching evidence only: keep every explicitly labelled invoice.
export function invoiceReferences(purpose){
  if(typeof purpose!=='string')return [];
  const found=[];
  const pattern=/(?<![\p{L}\p{N}])(?:(?:сч[её]т(?:у|а|ом)?|сч)(?:\s*(?:№|номер)\s*|\s+)|сч\.\s*(?:(?:№|номер)\s*)?)([\p{L}\p{N}][\p{L}\p{N}/._-]*)(?:\s+от\s+(\d{2}\.\d{2}\.(?:\d{4}|\d{2})))?/giu;
  for(const m of purpose.matchAll(pattern)){
    if(!/\d/u.test(m[1])&&!/(?:№|номер)/iu.test(m[0]))continue;
    if(/(?:расч[её]тн\p{L}*|корреспондентск\p{L}*|банковск\p{L}*|лицев\p{L}*)\s*$/iu.test(purpose.slice(0,m.index)))continue;
    const item={number:m[1],date:m[2]??null,evidence:m[0]};
    if(!found.some(x=>x.number===item.number&&x.date===item.date))found.push(item);
  }
  return found;
}
