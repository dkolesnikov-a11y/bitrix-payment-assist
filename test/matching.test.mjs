import test from 'node:test';
import assert from 'node:assert/strict';
import {matchPayment,loadInvoices,formatMatches} from '../src/matching.mjs';
import {automaticCandidate} from '../src/automatic.mjs';
import {invoiceReferences} from '../src/invoice-references.mjs';

test('payment screenshot: invoice БП-502 without № selects 502 and excludes 480',()=>{
 const purpose='ОПЛАТА ПО СЧЕТУ БП-502 ОТ 15.09.2026 УСЛУГИ ПО ПРИГОТОВЛЕНИЮ ПИЩИ 1-15 СЕНТЯБРЯ 2026 Г СУММА 235107-00';
 assert.deepEqual(invoiceReferences(purpose).map(r=>[r.number,r.date]),[['БП-502','15.09.2026']]);
 const invoice={categoryId:31,stageId:'DT1078_31:CLIENT',currencyId:'RUB',companyId:9,mycompanyId:2285,ufCrm23_1768411333:'ООО "ДЕМО ДЕЛЬТА" (ИНН 0000000001)'};
 const result=matchPayment({payerName:'ООО "ДЕМО ДЕЛЬТА"',payerInn:'0000000001',amountCents:23510700,currency:'RUB',purpose},[
 {...invoice,id:2353,ufCrm23_1768411703:'502',ufCrm23_1770923673:'235107|RUB'},
 {...invoice,id:2247,ufCrm23_1768411703:'480',ufCrm23_1770923673:'252774|RUB'}]);
 assert.equal(result.decisive,true);assert.deepEqual(result.candidates.map(c=>c.id),[2353]);
 for(const text of ['за счет оплаты услуг','расчетный счет 123456789','счет на оплату'])assert.deepEqual(invoiceReferences(text),[]);
 assert.equal(invoiceReferences('по счету 502 от 15.09.26')[0].number,'502');
});
const p={payerName:'ЗАКРЫТОЕ АКЦИОНЕРНОЕ ОБЩЕСТВО «ДЕМО АЛЬФА»',amountCents:24640000,currency:'RUB',purpose:'счет №БП-492 от 15.09.26'};
const item={id:1,categoryId:31,stageId:'DT1078_31:CLIENT',currencyId:'RUB',companyId:2,mycompanyId:2281,ufCrm23_1768411333:'ЗАО "Демо Альфа" (ИНН 0000000002)',ufCrm23_1768411703:'492',ufCrm23_1770923673:'246400|RUB'};

test('partial payment identifies unique invoice despite another invoice matching the amount',()=>{
 const payment={...p,payerName:'ООО «Демо Гамма»',payerInn:'0000000003',amountCents:10000000,date:'2026-09-23',direction:'incoming',status:'credited',bankReference:'123',purpose:'Оплата по счету № БП-492 от 15.09.2026'};
 const invoice={...item,ufCrm23_1768411333:'ООО"ДЕМО ГАММА" (ИНН 0000000003)'};
 const other={...invoice,id:2,ufCrm23_1768411703:'480',ufCrm23_1770923673:'100000|RUB'};
 for(const number of ['492','БП-492']){
  const result=matchPayment(payment,[{...invoice,ufCrm23_1768411703:number},other]);
  assert.equal(result.decisive,true);assert.deepEqual(result.candidates.map(c=>c.id),[1]);
  assert.equal(result.candidates[0].amountMatch,'partial');assert.deepEqual(result.excludedCandidates.map(c=>c.id),[2]);
  const text=formatMatches([result]);assert.match(text,/однозначно найден/);assert.match(text,/Частичная оплата/);assert.doesNotMatch(text,/Совпадают юрлицо, сумма/);
  assert.equal(automaticCandidate(payment,result,{enabled:true,fromEventId:0,fromDate:'2026-09-01',allowExactScreenshotPayments:true},100,'2026-09-23'),null);
 }
 const collision=matchPayment(payment,[invoice,{...invoice,id:3,mycompanyId:2285}]);
 assert.equal(collision.status,'ambiguous');assert.equal(collision.decisive,undefined);
 const multiple=matchPayment({...payment,purpose:'Оплата по счету 492 и счету 480'},[invoice,other]);
 assert.equal(multiple.decisive,undefined);
});

test('Demo Gamma: partial invoice 416 matches one member of CRM list 416,417',()=>{
 const payment={...p,payerName:'ООО Демо Гамма',payerInn:'0000000003',amountCents:8081920,purpose:'Оплата за мытье посуды согл сч БП-416 от 31.07.26'};
 const invoice={...item,id:1911,companyId:113,ufCrm23_1768411333:'ООО"ДЕМО ГАММА" (ИНН 0000000003)',ufCrm23_1770923673:'434537.40|RUB'};
 for(const number of ['416,417','416; 417','416\n417','БП-416, БП-417']){
  const r=matchPayment(payment,[{...invoice,ufCrm23_1768411703:number},{...invoice,id:2,ufCrm23_1768411703:'1416,417'}]);
  assert.equal(r.decisive,true);assert.equal(r.candidates[0].id,1911);assert.equal(r.candidates[0].amountMatch,'partial');
 }
 for(const number of ['1416,417','4160,417','416/417','416-417'])assert.equal(matchPayment(payment,[{...invoice,ufCrm23_1768411703:number}]).decisive,undefined);
 const duplicate=matchPayment(payment,[{...invoice,ufCrm23_1768411703:'416,417'},{...invoice,id:2,ufCrm23_1768411703:'416'}]);
 assert.equal(duplicate.status,'ambiguous');assert.equal(duplicate.decisive,undefined);
});

test('explicit invoice identifies element even when amount exceeds balance or balance is unknown',()=>{
 for(const balance of ['100|RUB','']){
  const r=matchPayment(p,[{...item,ufCrm23_1770923673:balance},{...item,id:2,ufCrm23_1768411703:'475'}]);
  assert.equal(r.decisive,true);assert.deepEqual(r.candidates.map(x=>x.id),[1]);
  assert.equal(automaticCandidate({...p,date:'2026-09-23',direction:'incoming',status:'credited'},r,{enabled:true,fromEventId:0,fromDate:'2026-09-01',allowExactScreenshotPayments:true},100,'2026-09-23'),null);
  assert.doesNotMatch(formatMatches([r]),/Сумма совпадает/);
 }
});

test('Demo Beta: explicit 495 is unique while equal balances 470 and 494 remain ambiguous',()=>{
 const base={...item,companyId:95,ufCrm23_1768411333:'АО "ДЕМО БЕТА" (ИНН 0000000004)'};
 const invoices=[{...base,id:2317,ufCrm23_1768411703:'495',ufCrm23_1770923673:'7490|RUB'},{...base,id:2187,ufCrm23_1768411703:'470',ufCrm23_1770923673:'74365|RUB'},{...base,id:2319,ufCrm23_1768411703:'494',ufCrm23_1770923673:'74365|RUB'}];
 const payment={payerName:'АО "Демо Бета"',currency:'RUB',direction:'incoming',status:'credited',amountCents:749000,purpose:'Оплата сч.БП-495 от 15.09.2026 дог.0...'};
 const one=matchPayment(payment,invoices);assert.equal(one.decisive,true);assert.deepEqual(one.candidates.map(x=>x.number),['495']);
 const two=matchPayment({...payment,amountCents:7436500,purpose:'Оплата по договору 01/08/2024 от 01....'},invoices);
 assert.equal(two.status,'ambiguous');assert.deepEqual(two.candidates.filter(x=>x.amountMatch==='exact').map(x=>x.number),['470','494']);
});
test('missing INN allows name and balance proposal, suffix is not exact invoice evidence',()=>{
 const r=matchPayment(p,[item]);assert.equal(r.status,'candidate');assert.equal(r.candidates[0].amountMatch,'exact');assert.equal(r.candidates[0].numberMatch,'suffix');assert.equal(r.reviewOnly,true);assert.equal(r.candidates[0].recipientConfirmed,false);
});
test('same amount other party, closed invoice and conflicting INN never match',()=>{
 assert.equal(matchPayment(p,[{...item,ufCrm23_1768411333:'ООО Другая'},{...item,stageId:'DT1078_31:SUCCESS'}]).candidates.length,0);
 assert.equal(matchPayment({...p,payerInn:'0000000005'},[item]).candidates.length,0);
 assert.equal(matchPayment({...p,currency:'USD'},[item]).candidates.length,0);
 assert.equal(matchPayment({...p,direction:'outgoing'},[item]).candidates.length,0);
});
test('multiple invoices preserved even when one exact; partial, overpay and missing balance distinct',()=>{
 const r=matchPayment(p,[item,{...item,id:2,ufCrm23_1770923673:'300000|RUB'},{...item,id:3,ufCrm23_1770923673:'200000|RUB'},{...item,id:4,ufCrm23_1770923673:''}]);
 assert.equal(r.status,'ambiguous');assert.deepEqual(r.candidates.map(c=>c.amountMatch),['exact','partial','overpayment','unknown']);
});
test('cursor pagination reads all pages and rejects incomplete scans',async()=>{
 let n=0;const api={request:async path=>{assert.match(path,/^\/items\/1078/);return ++n===1?{data:[item],meta:{hasMore:true,nextAfterId:'1'}}:{data:[{...item,id:2}],meta:{hasMore:false}};}};
 assert.equal((await loadInvoices(api)).length,2);
 await assert.rejects(loadInvoices({request:async()=>({data:[item],meta:{hasMore:true}})}),/CURSOR/);
});

 test('invoice reference and exact payer and balance discard unrelated invoice numbers',()=>{
 const r=matchPayment(p,[item,{...item,id:2,ufCrm23_1768411703:'478',ufCrm23_1770923673:'300000|RUB'},{...item,id:3,ufCrm23_1768411703:'480',ufCrm23_1770923673:'200000|RUB'}]);
 assert.equal(r.decisive,true);assert.deepEqual(r.candidates.map(c=>c.id),[1]);assert.equal(r.excludedCandidates.length,2);
 const collision=matchPayment(p,[item,{...item,id:2,mycompanyId:2285}]);assert.equal(collision.decisive,undefined);assert.equal(collision.candidates.length,2);
 });
