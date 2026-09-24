import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.mjs';
import {processPayments} from '../src/payments.mjs';
import {paymentIdentity,paymentDate,bankReference} from '../src/payment-identity.mjs';
import {Journal,PaymentGuard,snapshot,cents,rub} from '../tools/payment-safety/guard.mjs';

function setup(t){
 const dir=mkdtempSync(join(tmpdir(),'payment-regressions-'));
 const store=new Store(join(dir,'store.sqlite')),journal=new Journal(join(dir,'journal.sqlite'));
 t.after(()=>{store.close();journal.close();rmSync(dir,{recursive:true,force:true});});
 let item={id:1,parentId2:2,companyId:103,mycompanyId:2281,categoryId:31,currencyId:'RUB',opportunity:100,updatedTime:'v0',stageId:'DT1078_31:CLIENT',ufCrm23_1770921060:'',ufCrm23_1770923673:'100|RUB'};
 let writes=0;const comments=[];
 const vibe={read:async()=>structuredClone(item),readComments:async()=>structuredClone(comments),apply:async(id,fields)=>{
  writes++;const amount=cents(fields.ufCrm23_1770921060),remaining=cents(item.ufCrm23_1770923673)-amount;
  item={...item,updatedTime:'v'+writes,stageId:remaining?'DT1078_31:UC_WEUS73':'DT1078_31:SUCCESS',ufCrm23_1770923673:rub(remaining)};
  comments.push({id:String(writes),amountCents:amount,actorId:'49'});return {accepted:true,actorId:'49'};
 }};
 const service={store,journal,vibe,guard:new PaymentGuard(journal,vibe),config:{crmWrites:true,invoiceAllowlist:[1],allowedUsers:[49],allowedDialogs:['49']}};
 function body(date='2026-09-22',reference='AB 2840'){
  return {paymentAuthorizedOnConfirm:true,payment:{amountCents:4000,currency:'RUB',direction:'incoming',status:'credited',bankReference:reference,date},selected:{id:1,number:'51',companyId:103,mycompanyId:2281,balanceCents:cents(item.ufCrm23_1770923673),recipientConfirmed:true},recipientReply:{author:49}};
 }
 function insert(id,b,state='review_ready'){store.db.prepare('INSERT INTO payment_dialogs VALUES(?,?,?,?,?,?)').run(id,0,'49',49,state,JSON.stringify(b));}
 function spec(b,legacy=false){const p=b.payment,s=b.selected;
  const fingerprint=legacy?createHash('sha256').update(JSON.stringify([s.companyId,s.mycompanyId,p.bankReference.trim().toUpperCase(),p.date.trim().toUpperCase(),p.amountCents,p.currency])).digest('hex'):paymentIdentity(p,s);
  return {id:'chat_'+fingerprint,fingerprint,invoiceId:1,parentId:2,amountCents:p.amountCents,before:snapshot(item),origin:{chatId:'49',messageId:'1'}};
 }
 return {service,store,journal,vibe,body,insert,spec,get writes(){return writes;},get balance(){return cents(item.ufCrm23_1770923673);}};
}

test('payment identity normalizes date and bank reference while preserving legal entity boundaries',()=>{
 assert.equal(paymentDate('22 сентября 2026'),'2026-09-22');assert.equal(paymentDate('22.09.2026'),'2026-09-22');assert.equal(paymentDate('31.02.2026'),null);
 assert.equal(bankReference(' № ab\u00a02840 '),'AB2840');
 const p={date:'2026-09-22',bankReference:'AB 2840',amountCents:4000,currency:'RUB'},s={companyId:103,mycompanyId:2281};
 assert.equal(paymentIdentity(p,s),paymentIdentity({...p,date:'22 сентября 2026',bankReference:'№ ab2840'},s));
 assert.notEqual(paymentIdentity(p,s),paymentIdentity(p,{...s,mycompanyId:2285}));
});

test('exact screenshot policy conducts full invoice once without inventing OCR status, and deduplicates replay',async t=>{
 const f=setup(t),b=f.body('2026-09-22',null);
 b.payment.amountCents=10000;b.payment.status=null;b.paymentAuthorizedOnConfirm=false;delete b.recipientReply;
 Object.assign(b.selected,{nameExact:true,amountMatch:'exact',numberMatch:'suffix'});
 b.autoAuthorization={rule:'exact-screenshot-v3',eventId:'1'};
 f.service.config.automatic={enabled:true,fromEventId:1,allowExactScreenshotPayments:false};
 f.insert('1',b);await processPayments(f.service);assert.equal(f.writes,0);
 f.service.config.automatic.allowExactScreenshotPayments=true;
 await processPayments(f.service);await processPayments(f.service);assert.equal(f.writes,1);assert.equal(f.balance,0);
 assert.equal(JSON.parse(f.store.db.prepare("SELECT body FROM payment_dialogs WHERE source_event='1'").get().body).payment.status,null);
 f.insert('2',b);await processPayments(f.service);assert.equal(f.writes,1);
 assert.equal(f.store.db.prepare("SELECT state FROM payment_dialogs WHERE source_event='2'").get().state,'payment_blocked');
});

test('manual partial payment replay with date/reference variations writes once',async t=>{
 const f=setup(t);f.insert('1',f.body());await processPayments(f.service);
 f.insert('2',f.body('22 сентября 2026','№ ab2840'));await processPayments(f.service);await processPayments(f.service);
 assert.equal(f.writes,1);assert.equal(f.balance,6000);
 const row=f.store.db.prepare("SELECT state,body FROM payment_dialogs WHERE source_event='2'").get();
 assert.equal(row.state,'payment_blocked');assert.equal(JSON.parse(row.body).paymentResult.reason,'DUPLICATE');
});

test('confirmed payment without bank reference writes once across replay and later supplied reference',async t=>{
 const f=setup(t);f.insert('1',f.body('22.09.2026',null));await processPayments(f.service);
 assert.equal(f.writes,1);assert.equal(f.store.db.prepare('SELECT state FROM payment_dialogs').get().state,'paid');
 assert.equal(JSON.parse(f.store.db.prepare('SELECT body FROM payment_dialogs').get().body).payment.bankReference,null);
 f.insert('2',f.body('22 сентября 2026',null));f.insert('3',f.body('2026-09-22','NEWLY-VISIBLE'));
 await processPayments(f.service);await processPayments(f.service);
 assert.equal(f.writes,1);assert.equal(f.balance,6000);
 assert.deepEqual(f.store.db.prepare('SELECT state FROM payment_dialogs ORDER BY source_event').all().map(x=>x.state),['paid','payment_blocked','payment_blocked']);
});

test('missing reference cannot bypass previous referenced payment or explicit consent',async t=>{
 const f=setup(t);const unconfirmed=f.body('2026-09-22',null);delete unconfirmed.recipientReply;
 f.insert('1',unconfirmed);await processPayments(f.service);assert.equal(f.writes,0);
 f.insert('2',f.body());await processPayments(f.service);assert.equal(f.writes,1);
 f.insert('3',f.body('22.09.2026',null));await processPayments(f.service);assert.equal(f.writes,1);
 assert.equal(JSON.parse(f.store.db.prepare("SELECT body FROM payment_dialogs WHERE source_event='3'").get().body).paymentResult.reason,'DUPLICATE');
});

test('uncertain reference-free payment remains reserved and is never resent',async t=>{
 const f=setup(t),b=f.body('2026-09-22',null),spec=f.spec(b);f.journal.reserve(spec);
 f.journal.transition(spec.id,['reserved'],'dispatched','SENT_OR_MAY_HAVE_BEEN_SENT');
 b.paymentSpec=spec;f.insert('1',b,'payment_pending');
 f.insert('2',f.body('22 сентября 2026','LATER-REFERENCE'));
 await processPayments(f.service);await processPayments(f.service);assert.equal(f.writes,0);
 assert.equal(f.journal.get(spec.id).status,'dispatched');
});

test('legacy raw fingerprint and immutable historical evidence block normalized replay',async t=>{
 const f=setup(t),old=f.body('22.09.2026',' ab 2840 ');old.paymentSpec=f.spec(old,true);
 f.insert('1',old,'payment_pending');await processPayments(f.service);
 const historical=f.journal.get(old.paymentSpec.id);
 f.insert('2',f.body('22 сентября 2026','AB2840'));await processPayments(f.service);
 assert.equal(f.writes,1);assert.equal(f.balance,6000);
 assert.deepEqual(f.journal.get(old.paymentSpec.id),historical);
 assert.equal(f.store.db.prepare("SELECT state FROM payment_dialogs WHERE source_event='2'").get().state,'payment_blocked');
});

test('persisted intent without journal operation is deduplicated before remote write',async t=>{
 const f=setup(t),first=f.body('22.09.2026');first.paymentSpec=f.spec(first,true);
 f.insert('1',first,'payment_pending');await processPayments(f.service);
 const second=f.body('22 сентября 2026','AB2840');second.paymentSpec=f.spec(second,true);
 f.insert('2',second,'payment_pending');await processPayments(f.service);
 assert.equal(f.writes,1);assert.equal(f.journal.get(second.paymentSpec.id),null);
 assert.equal(f.store.db.prepare("SELECT state FROM payment_dialogs WHERE source_event='2'").get().state,'payment_blocked');
});

test('legacy paid dialog without embedded spec still blocks the same payment',async t=>{
 const f=setup(t),first=f.body('22.09.2026');
 await f.service.guard.execute(f.spec(first,true));f.insert('1',first,'paid');
 f.insert('2',f.body('22 сентября 2026','AB2840'));await processPayments(f.service);
 assert.equal(f.writes,1);assert.equal(f.balance,6000);
 assert.equal(f.store.db.prepare("SELECT state FROM payment_dialogs WHERE source_event='2'").get().state,'payment_blocked');
});

test('unparseable date cannot bypass normalized payment identity',async t=>{
 const f=setup(t);f.insert('1',f.body('31.02.2026'));await processPayments(f.service);
 assert.equal(f.writes,0);assert.equal(f.balance,10000);
 assert.equal(JSON.parse(f.store.db.prepare('SELECT body FROM payment_dialogs').get().body).paymentResult.reason,'INCOMPLETE_EVIDENCE');
});

test('uncertain historical operation is never resent under a normalized identity',async t=>{
 const f=setup(t),apply=f.vibe.apply;f.vibe.apply=async(...args)=>{await apply(...args);throw Error('lost ack');};
 const first=f.body('22.09.2026');first.paymentSpec=f.spec(first,true);f.insert('1',first,'payment_pending');await processPayments(f.service);
 assert.equal(f.journal.get(first.paymentSpec.id).status,'uncertain');
 f.insert('2',f.body('22 сентября 2026','AB2840'));await processPayments(f.service);
 assert.equal(f.writes,1);assert.equal(f.balance,6000);
});

test('operator confirmation without after snapshot completes and allows next payment notification',async t=>{
 const f=setup(t),apply=f.vibe.apply;f.vibe.apply=async(...args)=>{await apply(...args);throw Error('lost ack');};
 const first=f.body();f.insert('1',first);await processPayments(f.service);
 const saved=JSON.parse(f.store.db.prepare("SELECT body FROM payment_dialogs WHERE source_event='1'").get().body);
 f.journal.confirmApplied(saved.paymentSpec.id,{actor:'operator49',evidence:'Confirmed once against CRM and bank document'});
 f.vibe.apply=apply;f.insert('2',f.body('2026-09-22','NEW-2841'));
 await processPayments(f.service);await processPayments(f.service);
 assert.equal(f.writes,2);assert.equal(f.balance,2000);
 assert.deepEqual(f.store.db.prepare('SELECT state FROM payment_dialogs ORDER BY source_event').all().map(r=>r.state),['paid','paid']);
 const firstReply=f.store.db.prepare("SELECT text FROM outbox WHERE id='payment:1:0:paid'").get().text;
 assert.match(firstReply,/подтверждено оператором/);assert.doesNotMatch(firstReply,/Остаток|Результат проверен в CRM|NaN/);
 assert.ok(f.store.db.prepare("SELECT text FROM outbox WHERE id='payment:2:0:paid'").get());
});

import {automaticCandidate,prepareAutomatic} from '../src/automatic.mjs';
import {matchPayment} from '../src/matching.mjs';
test('numbered partial auto policy requires unique active invoice and nonnegative balance',()=>{
 const p={amountCents:4000,currency:'RUB',direction:'incoming',status:'credited',date:'2026-09-23',bankReference:'1'};
 const c={id:1,stageId:'DT1078_31:CLIENT',nameExact:true,amountMatch:'partial',numberMatch:'suffix',balanceCents:10000};
 const policy={enabled:true,allowPartialPayments:true,fromEventId:1,fromDate:'2026-09-01'};
 const pick=(candidate=c,payment=p,patch={},decisive=true)=>automaticCandidate(payment,{decisive,candidates:[candidate]},{...policy,...patch},1,'2026-09-23');
 assert.equal(pick(),c);assert.equal(pick(c,p,{allowPartialPayments:false}),null);assert.equal(pick(c,p,{},false),null);
 for(const stageId of ['DT1078_31:SUCCESS','DT1078_31:NEW'])assert.equal(pick({...c,stageId}),null);
 for(const balanceCents of [3000,null,-1])assert.equal(pick({...c,balanceCents}),null);
 assert.equal(pick(c,{...p,status:null}),null);assert.equal(pick({...c,numberMatch:'unknown'}),null);
 assert.equal(pick(c,{...p,bankReference:null}),null);
 assert.equal(pick(c,{...p,bankReference:null},{allowExactScreenshotPayments:true}),c);
});
test('automatic partials process sequentially in partial stage, close at zero, and never replay',async t=>{
 const f=setup(t);f.service.config.automatic={enabled:true,allowPartialPayments:true,allowExactScreenshotPayments:true,fromEventId:1,fromDate:'2026-09-01'};
 f.vibe.request=async()=>({data:{title:'ИП Получатель'}});
 for(const [i,amount] of [4000,2000,4000].entries()){
  const p={...f.body().payment,amountCents:amount,payerName:'ООО Тест',purpose:'Оплата по счету 51',bankReference:'REF'+i};
  const item={...await f.vibe.read(),ufCrm23_1768411333:'ООО Тест',ufCrm23_1768411703:'51'};
  if(i)assert.equal(item.stageId,'DT1078_31:UC_WEUS73');
  const match=matchPayment(p,[item]);assert.equal(match.decisive,true);
  const job={id:String(i+1),body:JSON.stringify({date:'2026-09-23T12:00:00Z'})};
  assert.equal(await prepareAutomatic(f.service,job,{dialog:'49',author:49},[p],[match]),true);
  await processPayments(f.service);await processPayments(f.service);assert.equal(f.writes,i+1);
 }
 assert.equal(f.balance,0);assert.equal((await f.vibe.read()).stageId,'DT1078_31:SUCCESS');
 const b=JSON.parse(f.store.db.prepare("SELECT body FROM payment_dialogs WHERE source_event='1'").get().body);delete b.paymentSpec;
 f.insert('4',b);await processPayments(f.service);assert.equal(f.writes,3);
});
test('partial auto verifies current balance and accepts preparation stage only when unchanged',async t=>{
 for(const stale of [true,false]){
  const f=setup(t),b=f.body();b.paymentAuthorizedOnConfirm=false;delete b.recipientReply;
  Object.assign(b.selected,{nameExact:true,amountMatch:'partial',numberMatch:'exact',stageId:'DT1078_31:PREPARATION'});
  const read=f.vibe.read;f.vibe.read=async()=>({...await read(),stageId:'DT1078_31:PREPARATION'});
  b.autoAuthorization={rule:'numbered-partial-v1'};
  f.service.config.automatic={enabled:true,allowPartialPayments:true,fromEventId:1};
  if(stale)b.selected.balanceCents+=100;
  f.insert('1',b);await processPayments(f.service);assert.equal(f.writes,stale?0:1);
 }
});
