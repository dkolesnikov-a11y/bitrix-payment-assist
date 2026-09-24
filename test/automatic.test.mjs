import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.mjs';
import {automaticCandidate,paymentDate,prepareAutomatic} from '../src/automatic.mjs';
import {prepareChoiceButtons} from '../src/dialog.mjs';
const p={payerName:'ООО Тест',amountCents:10000,currency:'RUB',direction:'incoming',status:'credited',date:'18 сентября 2026',bankReference:'123',recipientName:'ООО ДЕМО ПОЛУЧАТЕЛЬ'};
const candidate={id:1,companyId:2,mycompanyId:3,nameExact:true,amountMatch:'exact',numberMatch:'unknown'};
const policy={enabled:true,fromEventId:20,fromDate:'2026-09-18'};

test('mixed screenshot queues only its unique invoice, keeps original indexes and ambiguous buttons',async t=>{
 for(const reverse of [false,true]){
  const store=new Store(':memory:');t.after(()=>store.close());
  const exact={...candidate,id:495,number:'495',numberMatch:'suffix',balanceCents:10000};
  const ambiguous=[{...candidate,id:470,number:'470'},{...candidate,id:494,number:'494'}];
  const payments=[{...p,status:null,bankReference:null},{...p,status:null,bankReference:null,amountCents:7436500}];
  const matches=[{decisive:true,candidates:[exact]},{candidates:ambiguous}];
  if(reverse){payments.reverse();matches.reverse();}
  const config={crmWrites:true,invoiceAllowlist:[495,470,494],automatic:{...policy,allowExactScreenshotPayments:true}};
  const job={id:'35',body:JSON.stringify({date:'2026-09-22'})},context={dialog:'49',author:49};
  assert.equal(await prepareAutomatic({store,config,vibe:{request:async()=>({data:{title:'ООО ДЕМО ПОЛУЧАТЕЛЬ'}})}},job,context,payments,matches),false);
  let rows=store.db.prepare('SELECT * FROM payment_dialogs').all();assert.equal(rows.length,1);assert.equal(rows[0].payment_index,reverse?1:0);assert.equal(rows[0].state,'review_ready');
  assert.equal(JSON.parse(rows[0].body).autoAuthorization.rule,'exact-screenshot-v3');
  assert.equal(JSON.parse(rows[0].body).payment.status,null);
  const buttons=prepareChoiceButtons(store,job,context,payments,matches);assert.equal(buttons.length,2);assert.ok(buttons.every(b=>!b.TEXT.includes('495')));
  rows=store.db.prepare('SELECT * FROM payment_dialogs').all();assert.equal(rows.length,2);
 }
});

test('two numbered payments to one element cannot auto-close it using only the first payment',async t=>{
 const store=new Store(':memory:');t.after(()=>store.close());
 const payments=[{...p,amountCents:33326320,bankReference:'1897'},{...p,amountCents:98530111,bankReference:'1896'}];
 const matches=['exact','overpayment'].map(amountMatch=>({decisive:true,candidates:[{...candidate,numberMatch:'suffix',amountMatch,balanceCents:33326320}]}));
 const service={store,config:{crmWrites:true,invoiceAllowlist:[1],automatic:policy},vibe:{request:async()=>{throw Error('must not queue');}}};
 assert.equal(await prepareAutomatic(service,{id:'47',body:JSON.stringify({date:'2026-09-23'})},{dialog:'49',author:49},payments,matches),false);
 for(const m of matches){assert.equal(m.review.code,'BATCH_INVOICE_CONFLICT');assert.equal(m.review.allowPayment,false);}
 assert.equal(store.db.prepare('SELECT count(*) n FROM payment_dialogs').get().n,0);
});

test('screenshot opt-in requires explicit invoice match and rejects pending or outgoing evidence',()=>{
 const match={decisive:true,candidates:[{...candidate,numberMatch:'suffix'}]},q={...policy,allowExactScreenshotPayments:true};
 assert.ok(automaticCandidate({...p,bankReference:null,status:null},match,q,35,'2026-09-22'));
 assert.equal(automaticCandidate({...p,bankReference:null,status:null},match,policy,35,'2026-09-22'),null);
 assert.equal(automaticCandidate({...p,bankReference:null,status:null},{...match,decisive:false},q,35,'2026-09-22'),null);
 for(const status of ['pending','unknown'])assert.equal(automaticCandidate({...p,status},match,q,35,'2026-09-22'),null);
 assert.equal(automaticCandidate({...p,direction:'outgoing'},match,q,35,'2026-09-22'),null);
});

test('all distinct exact rows queue independently; untouched choices may upgrade, rejected choices never do',async t=>{
 const store=new Store(':memory:');t.after(()=>store.close());
 const config={crmWrites:true,invoiceAllowlist:[1,2],automatic:policy},vibe={request:async()=>({data:{title:'ООО ДЕМО ПОЛУЧАТЕЛЬ'}})};
 const job={id:'35',body:JSON.stringify({date:'2026-09-22'})},ctx={dialog:'49',author:49};
 const payments=[p,{...p,bankReference:'124'}],matches=[{candidates:[candidate]},{candidates:[{...candidate,id:2}]}];
 prepareChoiceButtons(store,job,ctx,payments,matches);
 assert.equal(await prepareAutomatic({store,config,vibe},job,ctx,payments,matches),true);
 assert.deepEqual(store.db.prepare('SELECT payment_index,state FROM payment_dialogs ORDER BY payment_index').all().map(r=>[r.payment_index,r.state]),[[0,'review_ready'],[1,'review_ready']]);
 assert.equal(await prepareAutomatic({store,config,vibe},job,ctx,payments,matches),false);
 const old=JSON.parse(store.db.prepare('SELECT body FROM payment_dialogs WHERE payment_index=0').get().body);
 old.selected=null;old.rejectedBy={author:49};
 store.db.prepare("UPDATE payment_dialogs SET state='awaiting_invoice',body=? WHERE payment_index=0").run(JSON.stringify(old));
 await prepareAutomatic({store,config,vibe},job,ctx,payments,matches);
 assert.equal(store.db.prepare('SELECT state FROM payment_dialogs WHERE payment_index=0').get().state,'awaiting_invoice');
});
test('missing payment date permits three invoice choices but cannot authorize payment',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'missing-payment-date-')),store=new Store(join(dir,'db'));
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 const service={store,config:{automatic:policy,crmWrites:true,invoiceAllowlist:[1]},vibe:{request:async()=>{throw Error('must not auto-pay');}}};
 const job={id:'33',body:JSON.stringify({date:'2026-09-22'})},context={dialog:'49',author:49};
 const payments=[498,499,496].map(n=>({...p,date:null,status:null,purpose:`Оплата по сч. БП-${n} от 15.09.2026`}));
 const matches=payments.map(()=>({candidates:[candidate]}));
 assert.equal(await prepareAutomatic(service,job,context,payments,matches),false);
 assert.equal(prepareChoiceButtons(store,job,context,payments,matches).length,3);
 for(const row of store.db.prepare('SELECT state,body FROM payment_dialogs').all()){
  const body=JSON.parse(row.body);assert.equal(row.state,'awaiting_invoice');assert.equal(body.review.allowPayment,false);assert.equal(body.payment.date,null);assert.equal(body.autoAuthorization,undefined);
 }
});
test('only unique exact match may qualify; INN absent is allowed',()=>{
 assert.equal(automaticCandidate(p,{candidates:[candidate]},policy,20,'2026-09-18').id,1);
 for(const candidates of [[candidate,{...candidate,id:2}],[{...candidate,nameExact:false}],[{...candidate,amountMatch:'partial'}],[{...candidate,numberMatch:'different'}],[candidate,{...candidate,id:2,amountMatch:'partial',mycompanyId:9}]])assert.equal(automaticCandidate(p,{candidates},policy,20,'2026-09-18'),null);
 assert.equal(automaticCandidate({...p,recipientName:null},{candidates:[candidate]},policy,20,'2026-09-18').id,1);
});
test('old events, historical payments and invalid dates cannot auto-run',()=>{
 assert.equal(paymentDate('18 сентября 2026'),'2026-09-18');assert.equal(paymentDate('31.02.2026'),null);
 assert.equal(automaticCandidate(p,{candidates:[candidate]},policy,19,'2026-09-18'),null);
 for(const date of ['17.09.2026','19.09.2026','unknown'])assert.equal(automaticCandidate({...p,date},{candidates:[candidate]},policy,20,'2026-09-18'),null);
});
test('missing recipient and bank details on screenshot do not block unique client and amount match',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'auto-no-bank-')),store=new Store(join(dir,'db'));t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 let reads=0;const service={store,config:{automatic:policy,crmWrites:true,invoiceAllowlist:[1]},vibe:{request:async path=>{assert.equal(path,'/companies/3');reads++;return {data:{title:'ООО ДЕМО ПОЛУЧАТЕЛЬ'}};}}};
 const accepted=await prepareAutomatic(service,{id:'20',body:JSON.stringify({date:'2026-09-18T17:00:00+03:00'})},{dialog:'49',author:49},[{...p,recipientName:null,recipientInn:null}],[{candidates:[candidate]}]);
 assert.equal(accepted,true);assert.equal(reads,1);
 const body=JSON.parse(store.db.prepare('SELECT body FROM payment_dialogs').get().body);
 assert.equal(body.recipientName,'ООО ДЕМО ПОЛУЧАТЕЛЬ');assert.equal(body.recipientSource,'matched_crm_invoice');assert.equal(body.recipientReply,undefined);
});
test('automatic queue verifies recipient, respects invoice allowlist and image duplicates',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'auto-')),store=new Store(join(dir,'db'));t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 const service={store,config:{automatic:policy,crmWrites:true,invoiceAllowlist:[1]},vibe:{request:async()=>({data:{title:'ООО ДЕМО ПОЛУЧАТЕЛЬ'}})}};
 const job={id:'20',body:JSON.stringify({date:'2026-09-18T17:00:00+03:00'})},ctx={dialog:'49',author:49};
 const call=()=>prepareAutomatic(service,job,ctx,[p],[{candidates:[candidate]}]);
 service.config.invoiceAllowlist=[];assert.equal(await call(),false);service.config.invoiceAllowlist=[1];
 service.vibe.request=async()=>({data:{title:'ООО Другая'}});assert.equal(await call(),false);
 service.vibe.request=async()=>({data:{title:'ООО ДЕМО ПОЛУЧАТЕЛЬ'}});assert.equal(await call(),true);
 const body=JSON.parse(store.db.prepare('SELECT body FROM payment_dialogs').get().body);assert.equal(body.recipientReply,undefined);assert.equal(body.autoAuthorization.rule,'exact-client-balance-v2');
 assert.equal(await call(),false);
 store.db.exec('DELETE FROM payment_dialogs');store.db.prepare('INSERT INTO artifacts VALUES(?,?,?,?,?)').run('19',1,'same','image/jpeg','path');store.db.prepare('INSERT INTO artifacts VALUES(?,?,?,?,?)').run('20',1,'same','image/jpeg','path');assert.equal(await call(),false);
});

test('recipient company scope enables automatic invoices outside old allowlist only for configured recipients',async()=>{
 const {automaticInvoiceAllowed}=await import('../src/payment-scope.mjs');
 const c={invoiceAllowlist:[2309],recipientCompanyIds:[2281,2285],automatic:{scope:'recipient_companies'}};
 assert.equal(automaticInvoiceAllowed(c,{id:2369,mycompanyId:2285}),true);
 assert.equal(automaticInvoiceAllowed(c,{id:999,mycompanyId:1137}),false);
 c.automatic.scope='allowlist';assert.equal(automaticInvoiceAllowed(c,{id:2369,mycompanyId:2285}),false);
});

test('automatic review explains blocked reasons and preserves permitted manual choices',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'auto-reasons-')),store=new Store(join(dir,'db'));t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 const service={store,config:{automatic:policy,crmWrites:true,invoiceAllowlist:[1]},vibe:{request:async()=>({data:{title:'ООО Другая'}})}};
 const job={id:'20',body:JSON.stringify({date:'2026-09-18T17:00:00+03:00'})},ctx={dialog:'49',author:49};
 async function check(payments,code,allowSelection=true,usedJob=job){
  const matches=payments.map(()=>({candidates:[candidate]}));
  assert.equal(await prepareAutomatic(service,usedJob,ctx,payments,matches),false);
  for(const match of matches){assert.equal(match.review.code,code);assert.equal(match.review.allowSelection,allowSelection);assert.ok(match.review.text.length>10);}
 }
 await check([p],'RECIPIENT_CONFLICT');
 service.vibe.request=async()=>{throw Error('offline');};await check([p],'RECIPIENT_UNAVAILABLE');
 await check([p,{...p,bankReference:'124'}],'BATCH_INVOICE_CONFLICT');
 await check([{...p,bankReference:' '}],'MISSING_BANK_REFERENCE',true);
 await check([{...p,date:'unknown'}],'INVALID_PAYMENT_DATE',true);
 await check([{...p,date:'15.09.2026'}],'INVALID_PAYMENT_DATE',false);
 await check([{...p,status:'unknown'}],'INCOMPLETE_EVIDENCE',false);
 await check([{...p,status:null}],'INCOMPLETE_EVIDENCE',true);
 await check([p],'OLD_EVENT',false,{...job,id:'19'});
 service.config.invoiceAllowlist=[];await check([p],'OUTSIDE_SCOPE',false);service.config.invoiceAllowlist=[1];
 service.config.crmWrites=false;await check([p],'WRITES_DISABLED');service.config.crmWrites=true;
 service.config.automatic={...policy,enabled:false};await check([p],'AUTOMATIC_DISABLED');service.config.automatic=policy;
 store.db.prepare('INSERT INTO payment_dialogs VALUES(?,?,?,?,?,?)').run('19',0,'49',49,'paid',JSON.stringify({payment:{...p,date:'18.09.2026',bankReference:'№ 1 2 3'},selected:candidate}));
 await check([p],'DUPLICATE_PAYMENT',false);
});

test('automatic route blocks a previously confirmed reference-free payment when reference appears later',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'auto-fallback-')),store=new Store(join(dir,'db'));t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 const config={automatic:policy,crmWrites:true,invoiceAllowlist:[1]};
 store.db.prepare('INSERT INTO payment_dialogs VALUES(?,?,?,?,?,?)').run('19',0,'49',49,'paid',JSON.stringify({payment:{...p,bankReference:null},selected:candidate}));
 const matches=[{candidates:[candidate]}];
 assert.equal(await prepareAutomatic({store,config,vibe:{request:async()=>{throw Error('must not run');}}},{id:'20',body:JSON.stringify({date:'2026-09-18'})},{dialog:'49',author:49},[p],matches),false);
 assert.equal(matches[0].review.code,'DUPLICATE_PAYMENT');assert.equal(matches[0].review.allowSelection,false);
});
