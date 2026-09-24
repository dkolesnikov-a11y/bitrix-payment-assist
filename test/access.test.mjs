import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.mjs';
import {Access} from '../src/access.mjs';
import {Vibe} from '../src/vibe.mjs';
function fixture(t){
 const store=new Store(':memory:');t.after(()=>store.close());
 const config={adminUsers:[49],allowedUsers:[49],allowedDialogs:['49'],botId:900};
 const access=new Access(config,store),vibe={request:async path=>({data:{id:Number(path.split('/').at(-1)),active:true}})};
 const command=(id,text,author=49,dialog=String(author))=>access.handle(vibe,{id:String(id)},{author,dialog,text});
 return {store,config,access,vibe,command};
}
test('only admin in their personal dialog can grant access, admin cannot be removed',async t=>{
 const f=fixture(t);
 await f.command(1,'доступ добавить 83',50);await f.command(2,'доступ добавить 83',49,'chat1');
 await f.command(3,'доступ убрать 49');assert.deepEqual(f.config.allowedUsers,[49]);
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM bot_access_audit').get().n,0);
});
test('grant survives reload and binds employee to their own dialog and new events',async t=>{
 const f=fixture(t);await f.command(10,'доступ добавить 83');
 assert.ok(f.config.allowedUsers.includes(83));assert.ok(f.config.allowedDialogs.includes('83'));
 const c={...f.config,allowedUsers:[49],allowedDialogs:['49']},restored=new Access(c,f.store);
 assert.ok(c.allowedUsers.includes(83));assert.equal(restored.accepts(83,'83',11),true);
 assert.equal(restored.accepts(83,'49',11),false);assert.equal(restored.accepts(83,'83',9),false);
});
test('revoke cancels pending choices and replies; regrant cannot revive old payment',async t=>{
 const f=fixture(t);await f.command(10,'доступ добавить 83');
 f.store.db.prepare('INSERT INTO payment_dialogs VALUES(?,?,?,?,?,?)').run('11',0,'83',83,'review_ready','{}');
 f.store.db.prepare('INSERT INTO outbox(id,event_id,dialog,text) VALUES(?,?,?,?)').run('old','11','83','old');
 await f.command(12,'доступ убрать 83');
 assert.ok(!f.config.allowedUsers.includes(83));assert.ok(!f.config.allowedDialogs.includes('83'));
 assert.equal(f.store.db.prepare("SELECT state FROM outbox WHERE id='old'").get().state,'cancelled');
 await f.command(13,'доступ добавить 83');
 assert.equal(f.store.db.prepare('SELECT state FROM payment_dialogs').get().state,'access_revoked');
 assert.equal(f.access.accepts(83,'83',11),false);assert.equal(f.config.accessFromEvents[83],13);
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM bot_access_audit').get().n,3);
});
test('invalid or unavailable employee never receives access',async t=>{
 const f=fixture(t);f.vibe.request=async()=>({data:{id:83,active:false}});
 await f.command(1,'доступ добавить 83');
 f.vibe.request=async()=>{throw Error('offline');};await f.command(2,'доступ добавить 84');
 assert.deepEqual(f.config.allowedUsers,[49]);
});
test('recipient scope rejects CRM write even when invoice is allowlisted',async()=>{
 const c={crmWrites:true,invoiceAllowlist:[1],recipientCompanyIds:[2281,2285]};let patches=0;
 const v=new Vibe(c,'unused');v.actorId='49';
 v.request=async(path,method)=>{if(method==='PATCH')patches++;return {data:{id:1,mycompanyId:1137}};};
 await assert.rejects(v.apply(1,{stageId:'DT1078_31:SUCCESS',ufCrm23_1770921060:'1|RUB'}),/RECIPIENT_NOT_ALLOWED/);
 assert.equal(patches,0);
});
