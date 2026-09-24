import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {VibeOcr,validateDraft,formatDraft} from '../src/vibe-ocr.mjs';
import {invoiceReferences} from '../src/invoice-references.mjs';
import {applyPaymentDatePolicy} from '../src/payment-date-policy.mjs';

test('incoming list counterparty is payer, compact invoice label remains separate from payment date',()=>{
 const p=validateDraft({payments:[{amountCents:749000,currency:'RUB',direction:'incoming',status:'credited',counterpartyName:'АО Демо Бета',payerName:null,recipientName:'АО Демо Бета',date:null,purpose:'Оплата сч.БП-495 от 15.09.2026 дог.0...'}]}).payments[0];
 assert.equal(p.payerName,'АО Демо Бета');assert.equal(p.recipientName,null);
 assert.equal(p.invoiceReferences[0].number,'БП-495');assert.equal(p.invoiceReferences[0].date,'15.09.2026');assert.equal(p.date,null);
 const event={eventId:35,date:'2026-09-22T22:15:00Z'},c={paymentDatePolicy:'message_when_missing'};
 assert.equal(applyPaymentDatePolicy(p,event,c).date,'2026-09-23');
 assert.equal(applyPaymentDatePolicy(p,event,{}).date,null);
 assert.equal(applyPaymentDatePolicy({...p,date:'2026-09-20'},event,c).date,'2026-09-20');
 assert.equal(applyPaymentDatePolicy(p,{...event,date:'2026-09-22'},c).date,null);
 const outgoing=validateDraft({payments:[{amountCents:100,currency:'RUB',direction:'outgoing',counterpartyName:'АО Демо Бета'}]}).payments[0];assert.equal(outgoing.payerName,null);
});
test('invoice reference is separate from contract and bank transaction; all explicit references retained',()=>{
 const purpose='По дог. №1506/06-26 от 30.06.2026, счет №БП-492 от 15.09.26; по счёту №А/15 от 16.09.2026';
 const refs=invoiceReferences(purpose);assert.equal(refs.length,2);
 assert.deepEqual(refs.map(r=>[r.number,r.date]),[['БП-492','15.09.26'],['А/15','16.09.2026']]);
 assert.deepEqual(invoiceReferences('Расчётный счет №123; договор №15; Платёж №2840'),[]);
 assert.deepEqual(invoiceReferences('Договор №15; Платёж №2840'),[]);
 const draft=validateDraft({payments:[{amountCents:24640000,purpose,bankReference:'2840'}]});
 assert.equal(draft.payments[0].bankReference,'2840');assert.equal(draft.payments[0].invoiceReferences[0].number,'БП-492');
 assert.match(formatDraft([draft]),/Счет из назначения: № БП-492 от 15.09.26/);
});
test('OCR amount must agree with literal digits, including grouped amounts and kopecks',()=>{
 for(const amountText of ['+333 263,20 ₽','333\u00a0263,20','333\u202f263.20 RUB','333263,20'])assert.equal(validateDraft({payments:[{amountCents:33326320,amountText}]},{requireAmountEvidence:true}).payments[0].amountCents,33326320);
 for(const amountText of ['333 263,20',null,'33 3263,20','-333263,20'])assert.throws(()=>validateDraft({payments:[{amountCents:3332620,amountText}]},{requireAmountEvidence:true}),/OCR_AMOUNT_EVIDENCE_MISMATCH/);
});

test('unknown parties remain unknown and cannot authorize a payment',()=>{
 const d=validateDraft({payments:[{amountCents:12345,payerInn:'123',payerName:'Example [USER=1]'}]});
 assert.equal(d.reviewOnly,true);assert.equal(d.payments[0].payerInn,null);assert.ok(d.payments[0].missing.includes('payerInn'));
 const text=formatDraft([d]);assert.match(text,/123.45/);assert.ok(!text.includes('[USER'));assert.match(text,/не проводилась/);
 assert.throws(()=>validateDraft({payments:[{amountCents:1.5}]}),/AMOUNT/);
});

test('abbreviated invoice labels retain invoice numbers and invoice dates',()=>{
 for(const [purpose,number] of [['Оплата по сч. БП-498 от 15.09.26','БП-498'],['Оплата по сч № БП-499 от 15.09.2026','БП-499'],['Оплата по сч. БП-496','БП-496']]){
  const draft=validateDraft({payments:[{amountCents:10000,purpose,date:null}]});
  assert.equal(draft.payments[0].invoiceReferences[0].number,number);
  assert.equal(draft.payments[0].date,null);
 }
 assert.deepEqual(invoiceReferences('Расчетный сч. №123'),[]);
});
test('vision calls fixed model with existing key and rejects truncated output',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'vision-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const key=join(dir,'key');writeFileSync(key,'vibe_api_test');
 let finish='stop';const ocr=new VibeOcr(key,async(url,opts)=>{
   assert.equal(url,'https://vibecode.bitrix24.tech/v1/chat/completions');const b=JSON.parse(opts.body);
   assert.equal(b.model,'bitrix/bitrixgpt-5.5');assert.match(b.messages[1].content[1].image_url.url,/^data:image\/jpeg;base64,/);
   assert.equal(b.tools,undefined);
   return new Response(JSON.stringify({choices:[{finish_reason:finish,message:{content:JSON.stringify({payments:[{amountCents:10000,amountText:'100,00',currency:'RUB',direction:null,status:null}]})}}]}));
 });
 assert.equal((await ocr.extract({mime:'image/jpeg',bytes:Buffer.from('test')})).payments[0].amountCents,10000);
 finish='length';await assert.rejects(ocr.extract({mime:'image/jpeg',bytes:Buffer.from('test')}),/INCOMPLETE/);
});
