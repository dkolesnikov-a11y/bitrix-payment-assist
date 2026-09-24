import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Journal,PaymentGuard,snapshot,cents,rub} from './guard.mjs';

const initial=()=>({id:2381,parentId2:488403,categoryId:31,companyId:103,mycompanyId:2281,
  opportunity:100,currencyId:'RUB',updatedTime:'2026-09-18T12:00:00Z',
  stageId:'DT1078_31:UC_WEUS73',ufCrm23_1770923673:'100|RUB',ufCrm23_1770921060:''});
function setup(t) {
  const dir=mkdtempSync(join(tmpdir(),'payment-guard-')); const path=join(dir,'journal.sqlite');
  const journals=[]; const open=()=>{const j=new Journal(path);journals.push(j);return j;};
  t.after(()=>{for(const j of journals){try{j.close();}catch{}}rmSync(dir,{recursive:true,force:true});});
  const j=open(); let item=initial(), calls=0;const comments=[];
  const adapter={read:async()=>structuredClone(item),readComments:async()=>structuredClone(comments),apply:async(id,body)=>{
    calls++;assert.equal(id,item.id);assert.deepEqual(Object.keys(body).sort(),['stageId','ufCrm23_1770921060']);
    const remaining=cents(item.ufCrm23_1770923673)-cents(body.ufCrm23_1770921060);
    item={...item,ufCrm23_1770923673:rub(remaining),stageId:remaining?'DT1078_31:UC_WEUS73':'DT1078_31:SUCCESS',updatedTime:'2026-09-18T12:01:00Z'};
    comments.push({id:String(calls),amountCents:cents(body.ufCrm23_1770921060),actorId:'49'});
    return {accepted:true,actorId:'49'};
  }};
  const spec={id:'operation1',fingerprint:'a'.repeat(64),invoiceId:2381,parentId:488403,amountCents:4000,before:snapshot(item),origin:{chatId:'chat-test',messageId:'message1'}};
  return {j,open,adapter,spec,comments,guard:new PaymentGuard(j,adapter),get calls(){return calls;},get item(){return item;},set item(v){item=v;}};
}
test('acknowledged payment with exact readback and one new comment confirms automatically',async t=>{
  const f=setup(t);assert.equal((await f.guard.execute(f.spec)).status,'confirmed');
  assert.equal((await f.guard.execute(f.spec)).status,'confirmed');
  assert.equal((await f.guard.execute({...f.spec,id:'different-id'})).id,'operation1');
  assert.equal(f.calls,1);assert.equal(cents(f.item.ufCrm23_1770923673),6000);
});
test('CLIENT start accepts payment, NEW start is refused',async t=>{
 const f=setup(t);f.item={...f.item,stageId:'DT1078_31:CLIENT'};f.spec.before=snapshot(f.item);
 assert.equal((await f.guard.execute(f.spec)).status,'confirmed');assert.equal(f.calls,1);
 await assert.rejects(f.guard.execute({...f.spec,id:'other',fingerprint:'b'.repeat(64),before:{...f.spec.before,stage:'DT1078_31:NEW'}}),/UNTESTED_START_STATE/);
});
test('BP comment author is the captured responsible, different from API actor',async t=>{
 const f=setup(t);f.item={...f.item,assignedById:83};f.adapter.paymentCommentAuthorField='assignedById';
 const apply=f.adapter.apply;f.adapter.apply=async(...args)=>{const ack=await apply(...args);f.comments[0].actorId='83';return ack;};
 const op=await f.guard.execute(f.spec);assert.equal(op.status,'confirmed');assert.equal(op.evidence.actorId,'83');assert.equal(op.evidence.apiActorId,'49');assert.equal(op.evidence.authorRule,'invoice_responsible');
 await new PaymentGuard(f.open(),f.adapter).execute(f.spec);assert.equal(f.calls,1);
});
test('unrelated comment author is not accepted even if amount and balance match',async t=>{
 const f=setup(t);f.item={...f.item,assignedById:83};f.adapter.paymentCommentAuthorField='assignedById';
 const apply=f.adapter.apply;f.adapter.apply=async(...args)=>{const ack=await apply(...args);f.comments[0].actorId='99';return ack;};
 assert.equal((await f.guard.execute(f.spec)).status,'observed');assert.equal(f.calls,1);
});
test('missing responsible blocks before sending and changing responsible blocks reconciliation',async t=>{
 const f=setup(t);f.adapter.paymentCommentAuthorField='assignedById';assert.equal((await f.guard.execute(f.spec)).reason,'PREFLIGHT_UNAVAILABLE');assert.equal(f.calls,0);
 const g=setup(t);g.item={...g.item,assignedById:83};g.adapter.paymentCommentAuthorField='assignedById';const apply=g.adapter.apply;
 g.adapter.apply=async(...args)=>{const ack=await apply(...args);g.comments[0].actorId='83';g.item={...g.item,assignedById:99};return ack;};
 assert.equal((await g.guard.execute(g.spec)).reason,'COMMENT_AUTHOR_CHANGED');assert.equal(g.calls,1);
});
test('responsible-author acknowledgement survives restart and readback outage',async t=>{
 const f=setup(t);f.item={...f.item,assignedById:83};f.adapter.paymentCommentAuthorField='assignedById';const apply=f.adapter.apply,read=f.adapter.read;
 f.adapter.apply=async(...args)=>{const ack=await apply(...args);f.comments[0].actorId='83';f.adapter.read=async()=>{throw Error('offline');};return ack;};
 assert.equal((await f.guard.execute(f.spec)).status,'uncertain');f.adapter.read=read;
 assert.equal((await new PaymentGuard(f.open(),f.adapter).reconcile(f.spec.id)).status,'confirmed');assert.equal(f.calls,1);
});
test('responsible-author comment still requires API acknowledgement and uniqueness',async t=>{
 const f=setup(t);f.item={...f.item,assignedById:83};f.adapter.paymentCommentAuthorField='assignedById';const apply=f.adapter.apply;
 f.adapter.apply=async(...args)=>{await apply(...args);f.comments[0].actorId='83';throw Error('lost ack');};
 await f.guard.execute(f.spec);assert.equal((await f.guard.reconcile(f.spec.id)).status,'observed');
 const g=setup(t);g.item={...g.item,assignedById:83};g.adapter.paymentCommentAuthorField='assignedById';const apply2=g.adapter.apply;
 g.adapter.apply=async(...args)=>{const ack=await apply2(...args);g.comments[0].actorId='83';g.comments.push({id:'extra',actorId:'83',amountCents:4000});return ack;};
 assert.equal((await g.guard.execute(g.spec)).status,'observed');
});
test('applied payment followed by transport timeout is quarantined across restart',async t=>{
  const f=setup(t),apply=f.adapter.apply;f.adapter.apply=async(...args)=>{await apply(...args);throw Error('timeout');};
  assert.equal((await f.guard.execute(f.spec)).status,'uncertain');
  const restarted=new PaymentGuard(f.open(),f.adapter);
  await restarted.execute(f.spec);assert.equal(f.calls,1);
  assert.equal((await restarted.reconcile(f.spec.id)).status,'observed');assert.equal(f.calls,1);
  await assert.rejects(restarted.execute({...f.spec,id:'next',fingerprint:'b'.repeat(64)}),/RECONCILIATION_REQUIRED/);
});
test('crash after durable dispatch cannot resend even if request never left',async t=>{
  const f=setup(t);f.j.reserve(f.spec);f.j.transition(f.spec.id,['reserved'],'dispatched','CRASH_WINDOW');
  const restarted=new PaymentGuard(f.open(),f.adapter);
  assert.equal((await restarted.execute(f.spec)).status,'dispatched');assert.equal(f.calls,0);
  assert.equal((await restarted.reconcile(f.spec.id)).status,'uncertain');assert.equal(f.calls,0);
});
test('manual preflight change blocks payment without a write',async t=>{
  const f=setup(t);f.item={...f.item,ufCrm23_1770923673:'80|RUB',updatedTime:'changed'};
  const result=await f.guard.execute(f.spec);assert.equal(result.status,'rejected');assert.equal(result.reason,'PRECONDITION_CHANGED');assert.equal(f.calls,0);
});
test('crash with only reserved intent also requires review rather than automatic dispatch',async t=>{
  const f=setup(t);f.j.reserve(f.spec);
  assert.equal((await new PaymentGuard(f.open(),f.adapter).execute(f.spec)).status,'reserved');
  assert.equal(f.calls,0);
});
test('manual payment after preflight is detected as mismatch, not silently retried',async t=>{
  const f=setup(t),apply=f.adapter.apply;
  f.adapter.apply=async(...args)=>{
    // Locks in our journal cannot stop a person editing Bitrix outside the bot.
    f.item={...f.item,ufCrm23_1770923673:'80|RUB'};
    return apply(...args);
  };
  assert.equal((await f.guard.execute(f.spec)).status,'uncertain');
  assert.equal(cents(f.item.ufCrm23_1770923673),4000);
  await f.guard.execute(f.spec);assert.equal(f.calls,1);
});
test('changed version alone also blocks; unavailable preflight does not send',async t=>{
  const f=setup(t);f.item={...f.item,updatedTime:'changed'};assert.equal((await f.guard.execute(f.spec)).status,'rejected');
  f.adapter.read=async()=>{throw Error('offline');};
  const next={...f.spec,id:'next',fingerprint:'b'.repeat(64)};
  assert.equal((await f.guard.execute(next)).reason,'PREFLIGHT_UNAVAILABLE');assert.equal(f.calls,0);
});
test('two workers sharing SQLite reserve a bank fingerprint once',async t=>{
  const f=setup(t),other=new PaymentGuard(f.open(),f.adapter);
  await Promise.all([f.guard.execute(f.spec),other.execute({...f.spec,id:'other'})]);assert.equal(f.calls,1);
});
test('another operation cannot enter the same parent while outcome is unresolved',async t=>{
  const f=setup(t);f.j.reserve(f.spec);const second={...f.spec,id:'second',fingerprint:'b'.repeat(64),invoiceId:999,before:{...f.spec.before,invoiceId:999}};
  await assert.rejects(new PaymentGuard(f.open(),f.adapter).execute(second),/RECONCILIATION_REQUIRED/);assert.equal(f.calls,0);
});
test('same fingerprint with changed amount is a conflict, not a new payment',async t=>{
  const f=setup(t);await f.guard.execute(f.spec);
  await assert.rejects(f.guard.execute({...f.spec,id:'other',amountCents:5000}),/OPERATION_MISMATCH/);assert.equal(f.calls,1);
});
test('unknown result never gets marked paid merely because balance matches',async t=>{
  const f=setup(t);f.j.reserve(f.spec);f.j.transition(f.spec.id,['reserved'],'dispatched','INTENT');
  // Could be a manual payment of the same amount, not ours.
  f.item={...f.item,ufCrm23_1770923673:'60|RUB'};
  assert.equal((await f.guard.reconcile(f.spec.id)).status,'observed');assert.equal(f.calls,0);
  assert.throws(()=>f.j.confirmApplied(f.spec.id,{actor:'',evidence:'seen'}),/OPERATOR_REQUIRED/);
});
test('manual reconciliation releases locks and retains fingerprint and audit',async t=>{
  const f=setup(t),apply=f.adapter.apply;f.adapter.apply=async(...args)=>{await apply(...args);throw Error('timeout');};await f.guard.execute(f.spec);
  f.j.confirmApplied(f.spec.id,{actor:'test-operator',evidence:'Test evidence, not a portal payment'});
  await f.guard.execute(f.spec);assert.equal(f.calls,1);
  f.adapter.apply=apply;
  const next={...f.spec,id:'second',fingerprint:'b'.repeat(64),amountCents:6000,before:snapshot(f.item)};
  assert.equal((await f.guard.execute(next)).status,'confirmed');assert.equal(cents(f.item.ufCrm23_1770923673),0);
  assert.equal(f.j.db.prepare("SELECT count(*) AS n FROM events WHERE reason='OPERATOR_CONFIRMED'").get().n,1);
});
test('stale stage or full amount mismatch never passes reconciliation',async t=>{
  const f=setup(t);f.j.reserve(f.spec);f.j.transition(f.spec.id,['reserved'],'dispatched','INTENT');
  f.item={...f.item,ufCrm23_1770923673:'60|RUB',stageId:'DT1078_31:SUCCESS'};
  assert.equal((await f.guard.reconcile(f.spec.id)).status,'uncertain');
  f.item={...f.item,stageId:'DT1078_31:UC_WEUS73',opportunity:200};
  assert.equal((await f.guard.reconcile(f.spec.id)).status,'uncertain');assert.equal(f.calls,0);
});
test('readback failure retains quarantine after successful dispatch',async t=>{
  const f=setup(t),apply=f.adapter.apply;f.adapter.apply=async(...args)=>{const result=await apply(...args);f.adapter.read=async()=>{throw Error('offline');};return result;};
  assert.equal((await f.guard.execute(f.spec)).reason,'READBACK_UNAVAILABLE');
  await f.guard.execute(f.spec);assert.equal(f.calls,1);
});
test('invalid money never reaches transport; kopecks are exact',async t=>{
  const f=setup(t);for(const amount of [0,-1,0.1,Number.MAX_SAFE_INTEGER+1])
    await assert.rejects(f.guard.execute({...f.spec,amountCents:amount}));
  for(const value of ['NaN|RUB','1.001|RUB','1|USD','-1|RUB','1e2|RUB'])assert.throws(()=>cents(value));
  assert.equal(cents('0.01|RUB'),1);assert.equal(rub(101),'1.01|RUB');
  assert.equal(cents(rub(Number.MAX_SAFE_INTEGER)),Number.MAX_SAFE_INTEGER);assert.equal(f.calls,0);
});
test('transport sends the actual amount without rounding or a local tolerance gate',async t=>{
  const f=setup(t);
  let body;
  f.adapter.apply=async(id,value)=>{body=value;};
  await f.guard.execute({...f.spec,amountCents:10200});
  assert.deepEqual(body,{ufCrm23_1770921060:'102.00|RUB',stageId:'DT1078_31:SUCCESS'});
  assert.equal(f.j.get(f.spec.id).status,'uncertain'); // No invented successful settlement.
});
test('an acknowledged request without a new payment comment is not auto-confirmed',async t=>{
  const f=setup(t),apply=f.adapter.apply;f.adapter.apply=async(...args)=>{const r=await apply(...args);f.comments.length=0;return r;};
  assert.equal((await f.guard.execute(f.spec)).status,'observed');assert.equal(f.calls,1);
});
test('extra competing comment prevents automatic confirmation',async t=>{
  const f=setup(t),apply=f.adapter.apply;f.adapter.apply=async(...args)=>{const r=await apply(...args);f.comments.push({id:'manual',amountCents:4000,actorId:'83'});return r;};
  assert.equal((await f.guard.execute(f.spec)).status,'observed');assert.equal(f.calls,1);
});
test('successful request can finish automatically after temporary readback outage',async t=>{
  const f=setup(t),apply=f.adapter.apply,read=f.adapter.read;
  f.adapter.apply=async(...args)=>{const r=await apply(...args);f.adapter.read=async()=>{throw Error('offline');};return r;};
  assert.equal((await f.guard.execute(f.spec)).status,'uncertain');f.adapter.read=read;
  assert.equal((await new PaymentGuard(f.open(),f.adapter).reconcile(f.spec.id)).status,'confirmed');assert.equal(f.calls,1);
});
test('change during final observation blocks automatic confirmation',async t=>{
  const f=setup(t),readComments=f.adapter.readComments;let n=0;
  f.adapter.readComments=async()=>{const r=await readComments();if(++n===2)f.item={...f.item,updatedTime:'manual-update'};return r;};
  assert.equal((await f.guard.execute(f.spec)).reason,'RESULT_CHANGED_DURING_CHECK');assert.equal(f.calls,1);
});
