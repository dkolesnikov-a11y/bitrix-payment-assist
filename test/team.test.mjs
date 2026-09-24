import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.mjs';
import {Service} from '../src/service.mjs';
import {matchPayment} from '../src/matching.mjs';
import {teamMembers} from '../src/team.mjs';
import {processPayments} from '../src/payments.mjs';
import {Vibe} from '../src/vibe.mjs';
function setup(t){
 const dir=mkdtempSync(join(tmpdir(),'team-')),store=new Store(join(dir,'db'));
 const config={dataDir:dir,botId:900,adminUsers:[49],uploadUsers:[49],teamDialog:'chat123',allowedUsers:[49],allowedDialogs:['49','chat123'],invoiceAllowlist:[1],crmWrites:false,sendMessages:false};
 let members=[49,83,85],downloads=0;
 const item={id:1,categoryId:31,stageId:'DT1078_31:CLIENT',companyId:10,mycompanyId:2281,currencyId:'RUB',ufCrm23_1768411333:'ООО Тест',ufCrm23_1768411703:'492',ufCrm23_1770923673:'100|RUB'};
 const payment={payerName:'ООО Тест',amountCents:10000,currency:'RUB',date:'2026-09-22',bankReference:'T-1',direction:'incoming',status:'credited'};
 const api={read:async()=>item,request:async path=>path.endsWith('/users?limit=200')?{data:members.map(id=>({id,active:true,bot:false}))}:{data:{title:'ИП Примеров'}},download:async()=>{downloads++;throw Error('NOT_EXPECTED');}};
 const service=new Service(config,store,api,{});
 t.after(()=>{service.close();store.close();rmSync(dir,{recursive:true,force:true});});
 const event=(id,author,text,files=[],dialog='chat123')=>({eventId:id,date:'2026-09-22T12:00:00+03:00',type:'ONIMBOTV2MESSAGEADD',data:{bot:{id:900},chat:{dialogId:dialog},message:{id:100+id,authorId:author,text,params:{FILE_ID:files}}}});
 const send=async(id,author,text,files=[],dialog='chat123')=>{store.ingest({events:[event(id,author,text,files,dialog)],nextOffset:id+1});await service.process();return store.db.prepare('SELECT * FROM outbox WHERE event_id=?').get(String(id));};
 const seed=()=>{
  store.ingest({events:[event(1,49,'screenshot')],nextOffset:2});store.finish('1','review','MATCHED');
  store.db.prepare('INSERT INTO extracted VALUES(?,?,?)').run('1',1,JSON.stringify({payments:[payment]}));
  store.db.prepare('INSERT INTO matches VALUES(?,?)').run('1',JSON.stringify({matches:[matchPayment(payment,[item])]}));
 };
 return {store,service,config,api,event,send,seed,item,payment,set members(value){members=value;},get downloads(){return downloads;}};
}

test('mentioned employee question is answered automatically using replied payment and live deal without mutation',async t=>{
 const f=setup(t);f.seed();
 f.item.stageId='DT1078_31:SUCCESS';f.item.ufCrm23_1770923673='0|RUB';f.item.parentId2=483043;
 f.store.db.prepare('INSERT INTO payment_dialogs VALUES(?,?,?,?,?,?)').run('1',0,'chat123',49,'paid',JSON.stringify({payment:f.payment,selected:{id:1,number:'492'}}));
 f.store.db.prepare('INSERT INTO outbox(id,event_id,dialog,text,state,remote_id) VALUES(?,?,?,?,?,?)').run('event:1','1','chat123','Оплачено','sent','500');
 const original=f.api.request;const reads=[];f.api.request=async(path,...args)=>{assert.equal(args.length,0);reads.push(path);return path==='/deals/483043'?{data:{stageId:'C5:WON'}}:original(path);};
 const e=f.event(2,83,'[USER=900]Бот[/USER] почему не реализовал сделку в успех ?');e.data.message.params.REPLY_ID='500';
 f.store.ingest({events:[e],nextOffset:3});await f.service.process();await f.service.process();
 const replies=f.store.db.prepare("SELECT text FROM outbox WHERE event_id='2'").all();assert.equal(replies.length,1);
 assert.match(replies[0].text,/уже в стадии «Успех»/);assert.match(replies[0].text,/100.00 ₽/);assert.ok(reads.includes('/deals/483043'));
 assert.equal(f.store.db.prepare('SELECT state FROM payment_dialogs').get().state,'paid');
 assert.equal(f.service.journal.db.prepare('SELECT count(*) n FROM operations').get().n,0);
});

test('mention questions without context get guidance; ordinary chat and removed employees remain ignored',async t=>{
 const f=setup(t);
 assert.equal(await f.send(1,83,'почему не реализовал сделку в успех ?'),undefined);
 assert.match((await f.send(2,83,'[USER=900]Бот[/USER] почему нет оплаты?')).text,/ответьте на сообщение/);
 f.members=[49];assert.equal(await f.send(3,83,'[USER=900]Бот[/USER] какой статус?'),undefined);
});
test('team employee selects uploaders invoice and another member confirms exactly once',async t=>{
 const f=setup(t);f.seed();
 const reply=await f.send(2,83,'[USER=900]Помощник[/USER] счет 492');
 const token=JSON.parse(reply.keyboard)[0].COMMAND_PARAMS;
 let row=f.store.db.prepare('SELECT * FROM payment_dialogs').get();assert.equal(row.author,49);assert.equal(JSON.parse(row.body).selectedByAuthor,83);
 await f.send(3,85,'Подтвердить выбор '+token);
 row=f.store.db.prepare('SELECT * FROM payment_dialogs').get();assert.equal(row.state,'review_ready');assert.equal(JSON.parse(row.body).recipientReply.author,85);
 const duplicate=await f.send(4,83,'Подтвердить выбор '+token);assert.match(duplicate.text,/уже обработана/);
 assert.equal(JSON.parse(f.store.db.prepare('SELECT body FROM payment_dialogs').get().body).recipientReply.author,85);
});
test('removing member in Bitrix blocks their old button without a local config edit',async t=>{
 const f=setup(t);f.seed();const reply=await f.send(2,83,'счет 492');const token=JSON.parse(reply.keyboard)[0].COMMAND_PARAMS;
 f.members=[49,85];assert.equal(await f.send(3,83,'Подтвердить выбор '+token),undefined);
 assert.equal(f.store.db.prepare('SELECT state FROM payment_dialogs').get().state,'awaiting_recipient');
 await f.send(4,85,'Подтвердить выбор '+token);assert.equal(f.store.db.prepare('SELECT state FROM payment_dialogs').get().state,'review_ready');
});
test('only uploader can start image processing; team membership grants no personal chat access',async t=>{
 const f=setup(t);await f.send(1,83,'',[7]);assert.equal(f.downloads,0);
 assert.equal(f.service.accept(f.event(2,83,'счет 492',[],'83')),null);
 assert.equal(f.service.accept(f.event(2,83,'счет 492',[],'chat999')),null);
});
test('ordinary team conversation is ignored and membership outage retains event for retry',async t=>{
 const f=setup(t);assert.equal(await f.send(1,83,'Привет всем'),undefined);
 f.api.request=async()=>{throw Error('offline');};await f.send(2,83,'счет 492');
 assert.equal(f.store.db.prepare("SELECT state FROM inbox WHERE id='2'").get().state,'pending');
});
test('membership response must be complete and excludes inactive users and bots',async()=>{
 const c={botId:900,teamDialog:'chat123'};
 assert.deepEqual(await teamMembers({request:async()=>({data:[{id:49,active:true},{id:83,active:false},{id:900,active:true,bot:true}]})},c),[49]);
 await assert.rejects(teamMembers({request:async()=>({data:[],meta:{hasMore:true}})},c),/UNVERIFIED/);
});
test('employee removed after confirmation cannot authorize a new CRM dispatch',async t=>{
 const f=setup(t);f.config.crmWrites=true;
 const body={paymentAuthorizedOnConfirm:true,selected:{id:1,mycompanyId:2281},payment:{},recipientReply:{author:83}};
 f.store.db.prepare('INSERT INTO payment_dialogs VALUES(?,?,?,?,?,?)').run('1',0,'chat123',49,'review_ready',JSON.stringify(body));
 f.members=[49,85];let writes=0;
 f.service.guard.execute=async()=>{writes++;throw Error('UNEXPECTED');};
 await processPayments(f.service);
 assert.equal(writes,0);const row=f.store.db.prepare('SELECT * FROM payment_dialogs').get();
 assert.equal(row.state,'awaiting_recipient');assert.equal(JSON.parse(row.body).recipientReply,undefined);
});
test('private screenshot is forwarded once and its review is shared with team members',async t=>{
 const f=setup(t);f.config.sendMessages=true;
 f.api.download=async()=>({bytes:Buffer.from('test image'),mime:'image/png'});
 f.service.ocr={extract:async()=>({payments:[f.payment]})};
 const previous=f.api.request;f.api.request=async path=>path.startsWith('/items/1078?')?{data:[f.item],meta:{hasMore:false}}:previous(path);
 const sent=[];f.api.uploadImage=async(dialog,text,image)=>{sent.push({dialog,text,image});return String(1000+sent.length);};f.api.send=async(dialog,text,keyboard,forwardIds)=>{sent.push({dialog,text,forwardIds});return String(1000+sent.length);};
 await f.send(1,49,'',[7],'49');await f.service.deliver();await f.service.process();await f.service.deliver();
 assert.equal(sent.length,3);assert.equal(sent[1].image.bytes.toString(),'test image');assert.equal(sent[1].dialog,'chat123');
 assert.equal(sent[0].dialog,'49');assert.equal(sent[2].dialog,'chat123');
 const choice=await f.send(2,83,'счет 492');assert.match(choice.text,/Выбран счет/);
 assert.equal(f.store.db.prepare('SELECT dialog FROM payment_dialogs').get().dialog,'chat123');
 assert.equal(f.store.db.prepare('SELECT author FROM payment_dialogs').get().author,49);
});
test('forwarding adapter sends original message reference only to allowed dialog',async()=>{
 const v=new Vibe({botId:900,sendMessages:true,allowedDialogs:['chat123']},'unused');let body;
 v.request=async(path,method,value)=>{body=value;return {data:{id:99}};};
 assert.equal(await v.send('chat123','Платеж',undefined,{payment_1:101}),'99');
 assert.deepEqual(body.fields.forwardIds,{payment_1:101});
 await assert.rejects(v.send('chat999','Платеж',undefined,{payment_1:101}),/DISABLED/);
});
