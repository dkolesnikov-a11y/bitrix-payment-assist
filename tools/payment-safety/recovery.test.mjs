import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Journal,PaymentGuard,snapshot} from './guard.mjs';
import {Recovery} from './recovery.mjs';
function setup(t) {
  const dir=mkdtempSync(join(tmpdir(),'payment-review-')),path=join(dir,'journal.sqlite'),js=[];
  const open=()=>{const j=new Journal(path);js.push(j);return j;};
  t.after(()=>{for(const j of js){try{j.close();}catch{}}rmSync(dir,{recursive:true,force:true});});
  let item={id:2381,parentId2:488403,categoryId:31,companyId:103,mycompanyId:2281,opportunity:100,
    currencyId:'RUB',updatedTime:'v1',stageId:'DT1078_31:UC_WEUS73',ufCrm23_1770923673:'100|RUB',ufCrm23_1770921060:''};
  let writes=0, reads=0;
  const adapter={read:async()=>{reads++;return structuredClone(item);},apply:async()=>{writes++;item={...item,ufCrm23_1770923673:'60|RUB',updatedTime:'v2'};throw Error('timeout');}};
  const j=open(),guard=new PaymentGuard(j,adapter),recovery=new Recovery(guard,{allowedOperators:['49']});
  const spec={id:'test',fingerprint:'a'.repeat(64),invoiceId:2381,parentId:488403,amountCents:4000,before:snapshot(item),origin:{chatId:'chat-original',messageId:'source-message'}};
  const reply=requestId=>({eventId:'reply1',requestId,chatId:'chat-original',actorId:'49',action:'applied',evidence:'Checked this specific payment in the test history'});
  return {j,guard,recovery,spec,reply,adapter,open,get writes(){return writes;},get reads(){return reads;},get item(){return item;},set item(v){item=v;}};
}
test('recovery after timeout and restart only reads; one draft in original chat',async t=>{
  const f=setup(t);await f.guard.execute(f.spec);
  const restarted=new Recovery(new PaymentGuard(f.open(),f.adapter),{allowedOperators:['49']});
  await restarted.recover();await restarted.recover();
  assert.equal(f.writes,1);assert.equal(restarted.outbox().length,1);
  assert.equal(restarted.outbox()[0].chat_id,'chat-original');
  assert.equal(f.j.get('test').status,'observed');
});
test('operator confirmation is atomic and duplicate reply releases no new payment',async t=>{
  const f=setup(t);await f.guard.execute(f.spec);await f.recovery.recover();
  const reply=f.reply(f.recovery.outbox()[0].request_id);
  const result=await f.recovery.respond(reply);assert.equal(result.status,'confirmed');
  assert.deepEqual(await f.recovery.respond(reply),result);
  assert.equal(f.recovery.outbox().length,0);assert.equal(f.j.db.prepare('SELECT count(*) n FROM locks').get().n,0);
  await f.guard.execute(f.spec);assert.equal(f.writes,1);
  assert.equal(f.j.db.prepare("SELECT count(*) n FROM events WHERE reason='OPERATOR_CONFIRMED'").get().n,1);
});
test('wrong chat, unauthorized user, bare yes and no evidence cannot confirm',async t=>{
  const f=setup(t);await f.guard.execute(f.spec);await f.recovery.recover();const r=f.reply(f.recovery.outbox()[0].request_id);
  for(const change of [{chatId:'another-chat'},{actorId:'83'},{action:'yes'},{evidence:''}])await assert.rejects(f.recovery.respond({...r,...change}));
  assert.equal(f.j.get('test').status,'observed');assert.equal(f.writes,1);
});
test('changed invoice supersedes request and refuses stale approval',async t=>{
  const f=setup(t);await f.guard.execute(f.spec);await f.recovery.recover();const r=f.reply(f.recovery.outbox()[0].request_id);
  f.item={...f.item,ufCrm23_1770923673:'50|RUB',updatedTime:'v3'};
  await assert.rejects(f.recovery.respond(r),/STALE_REVIEW/);
  assert.equal(f.recovery.outbox().length,1);assert.notEqual(f.recovery.outbox()[0].request_id,r.requestId);
  assert.equal(f.j.get('test').status,'uncertain');assert.equal(f.writes,1);
});
test('not found answer never unlocks or retries a possibly late payment',async t=>{
  const f=setup(t);await f.guard.execute(f.spec);await f.recovery.recover();const r={...f.reply(f.recovery.outbox()[0].request_id),action:'not_found'};
  assert.equal((await f.recovery.respond(r)).status,'needs_review');
  await f.recovery.recover();assert.equal(f.recovery.outbox().length,1);
  await assert.rejects(f.guard.execute({...f.spec,id:'other',fingerprint:'b'.repeat(64)}),/RECONCILIATION_REQUIRED/);
  assert.equal(f.writes,1);
});
test('same inbound event ID cannot resolve a different action',async t=>{
  const f=setup(t);await f.guard.execute(f.spec);await f.recovery.recover();const r=f.reply(f.recovery.outbox()[0].request_id);
  await f.recovery.respond({...r,action:'not_found'});
  await assert.rejects(f.recovery.respond(r),/REPLY_EVENT_COLLISION/);assert.equal(f.j.get('test').status,'observed');
});
test('reserved crash can be cancelled safely, but cannot be called an applied payment',async t=>{
  const f=setup(t);f.j.reserve(f.spec);await f.recovery.recover();const r=f.reply(f.recovery.outbox()[0].request_id);
  await assert.rejects(f.recovery.respond(r),/ACTION_NOT_ALLOWED/);
  assert.equal((await f.recovery.respond({...r,action:'cancel_unsent'})).status,'rejected');
  await f.guard.execute(f.spec);assert.equal(f.writes,0);
});
test('sent attempt cannot be cancelled as unsent',async t=>{
  const f=setup(t);await f.guard.execute(f.spec);await f.recovery.recover();const r=f.reply(f.recovery.outbox()[0].request_id);
  await assert.rejects(f.recovery.respond({...r,action:'cancel_unsent'}),/ACTION_NOT_ALLOWED/);assert.equal(f.writes,1);
});
test('two recovery instances share one pending request',async t=>{
  const f=setup(t);await f.guard.execute(f.spec);
  const other=new Recovery(new PaymentGuard(f.open(),f.adapter),{allowedOperators:['49']});
  await Promise.all([f.recovery.recover(),other.recover()]);
  assert.equal(f.recovery.outbox().length,1);assert.equal(f.writes,1);
});
test('missing source context is rejected before a payment can be dispatched',async t=>{
  const f=setup(t);const spec={...f.spec};delete spec.origin;
  await assert.rejects(f.guard.execute(spec),/ORIGIN_REQUIRED/);assert.equal(f.writes,0);
});
test('restart removes a queued review when operation was already confirmed',async t=>{
  const f=setup(t);await f.guard.execute(f.spec);await f.recovery.recover();
  f.j.confirmApplied(f.spec.id,{actor:'49',evidence:'Operator checked specific test payment'});
  const restarted=new Recovery(new PaymentGuard(f.open(),f.adapter),{allowedOperators:['49']});
  await restarted.recover();assert.equal(restarted.outbox().length,0);assert.equal(f.writes,1);
});
