import {readFile} from 'node:fs/promises';
export class Ocr{
  constructor(config,fetcher=fetch){this.config=config;this.fetch=fetcher;}
  async extract(image){
    if(!this.config.url)throw Error('OCR_NOT_CONFIGURED');
    const headers={'Content-Type':'application/json'};
    if(this.config.keyFile)headers.Authorization='Bearer '+(await readFile(this.config.keyFile,'utf8')).trim();
    const r=await this.fetch(this.config.url,{method:'POST',headers,redirect:'error',signal:AbortSignal.timeout(60000),
      body:JSON.stringify({image:{mime:image.mime,base64:image.bytes.toString('base64')},schemaVersion:1})});
    if(!r.ok)throw Error('OCR_UNAVAILABLE');
    const raw=await r.text();if(raw.length>100000)throw Error('OCR_OUTPUT_TOO_LARGE');
    const d=JSON.parse(raw);
    if(!Array.isArray(d.payments)||d.payments.length>100)throw Error('INVALID_OCR_SCHEMA');
    for(const p of d.payments){
      if(!Number.isSafeInteger(p.amountCents)||p.amountCents<=0||p.currency!=='RUB'||p.direction!=='incoming'||p.status!=='credited')throw Error('PAYMENT_NEEDS_REVIEW');
      if(!/^\d{10}(?:\d{2})?$/.test(p.payerInn)||!/^\d{10}(?:\d{2})?$/.test(p.recipientInn))throw Error('PARTIES_NEED_REVIEW');
      if(typeof p.bankReference!=='string'||!p.bankReference.trim()||p.bankReference.length>200)throw Error('REFERENCE_NEEDS_REVIEW');
    }
    return d;
  }
}
