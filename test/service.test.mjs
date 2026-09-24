import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.mjs';
import {Service} from '../src/service.mjs';
import {Ocr} from '../src/ocr.mjs';
import {Vibe} from '../src/vibe.mjs';
function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'service-test-'));
  const c={dataDir:dir,botId:900,allowedUsers:[49],allowedDialogs:['49'],invoiceAllowlist:[2381],crmWrites:false,sendMessages:false,downloadHosts:['example.invalid'],maxFileBytes:1024};
  const store=new Store(join(dir,'events.sqlite'));let downloads=0,sends=0,payments=0;
  const api={download:async()=>{downloads++;return {bytes:Buffer.from([137,80,78,71,13,10,26,10]),mime:'image/png'};},send:async()=>{sends++;return 'sent';},apply:async()=>{payments++;throw Error('UNEXPECTED_WRITE');}};
  const service=new Service(c,store,api,new Ocr({url:''}));
  t.after(()=>{service.close();store.close();rmSync(dir,{recursive:true,force:true});});
  const event=(id=1)=>({eventId:id,type:'ONIMBOTV2MESSAGEADD',data:{bot:{id:900},dialogId:'49',message:{id:100+id,authorId:49,params:{FILE_ID:['7']}}}});
  return {c,store,api,service,event,get downloads(){return downloads;},get sends(){return sends;},get payments(){return payments;}};
}
test('incoming image is durable, duplicate event creates one file and one honest draft',async t=>{
  const f=fixture(t),page={events:[f.event()],nextOffset:2};f.store.ingest(page);await f.service.process();
  f.store.ingest(page);await f.service.process();await f.service.deliver();
  assert.equal(f.downloads,1);assert.equal(f.sends,0);assert.equal(f.payments,0);assert.equal(f.store.cursor(),2);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM artifacts').get().n,1);
  const reply=f.store.db.prepare('SELECT * FROM outbox').get();assert.equal(reply.dialog,'49');assert.match(reply.text,/не проводилась/);
});
test('live message shape uses nested chat dialog and replies exactly once',async t=>{
  const f=fixture(t),e=f.event();delete e.data.dialogId;e.data.chat={dialogId:'49',type:'private'};f.c.sendMessages=true;
  f.store.ingest({events:[e],nextOffset:2});await f.service.process();await f.service.deliver();await f.service.deliver();
  assert.equal(f.downloads,1);assert.equal(f.sends,1);assert.equal(f.payments,0);
  assert.equal(f.store.db.prepare('SELECT dialog FROM outbox').get().dialog,'49');
  e.data.dialogId='chat99';assert.equal(f.service.accept(e),null);
  delete e.data.dialogId;e.data.chat.dialogId='chat99';assert.equal(f.service.accept(e),null);
});
test('hidden keyboard command authenticates user and routes reply without exposing token',async t=>{
 const f=fixture(t);f.c.sendMessages=true;
 const e={eventId:10,type:'ONIMBOTV2COMMANDADD',data:{bot:{id:900},chat:{dialogId:'49'},user:{id:49},message:{id:200},command:{id:71,command:'payment_choice_confirm',context:'keyboard',params:'71d0693f-f561-45a1-a08e-8dcabfe33438'}}};
 assert.equal(f.service.accept(e).author,49);
 let answered=0;f.api.answerCommand=async(dialog,text,command)=>{assert.equal(dialog,'49');assert.deepEqual(command,{commandId:71,messageId:200});assert.ok(!text.includes('71d0693f'));answered++;return 'ok';};
 f.store.ingest({events:[e],nextOffset:11});await f.service.process();await f.service.deliver();assert.equal(answered,1);assert.equal(f.sends,0);
 e.data.user.id=83;assert.equal(f.service.accept(e),null);
 e.data.user.id=49;e.data.command.context='textarea';assert.equal(f.service.accept(e),null);
});
test('real keyboard event uses clicking user, slash command and original sent dialog',t=>{
 const f=fixture(t);f.store.db.prepare('INSERT INTO outbox(id,event_id,dialog,text,state,remote_id) VALUES(?,?,?,?,?,?)').run('button','0','49','test','sent','9546351');
 const e={type:'ONIMBOTV2COMMANDADD',data:{bot:{id:900},chat:{id:536585},user:{id:49},message:{id:9546351,authorId:900},command:{id:109,command:'/payment_choice_confirm',context:'keyboard',params:'5fde7328-1673-4c52-81d5-ee2f2c03fead'}}};
 assert.equal(f.service.accept(e).dialog,'49');assert.equal(f.service.accept(e).author,49);
 e.data.user.id=83;assert.equal(f.service.accept(e),null);e.data.user.id=49;
 e.data.chat.dialogId='chat999';assert.equal(f.service.accept(e),null);delete e.data.chat.dialogId;
 e.data.message.id=999;assert.equal(f.service.accept(e),null);
});
test('event page and cursor are atomic on conflicting event identity',t=>{
  const f=fixture(t);f.store.ingest({events:[f.event()],nextOffset:2});const changed=f.event();changed.data.message.text='changed';
  assert.throws(()=>f.store.ingest({events:[f.event(2),changed],nextOffset:3}),/COLLISION/);
  assert.equal(f.store.cursor(),2);assert.equal(f.store.db.prepare('SELECT count(*) n FROM inbox').get().n,1);
});
test('wrong user, chat, bot, system and own messages do not download or reply',async t=>{
  const f=fixture(t),events=[];
  for(let i=1;i<=5;i++){const e=f.event(i);if(i===1)e.data.message.authorId=83;if(i===2)e.data.dialogId='chat99';if(i===3)e.data.bot.id=901;if(i===4)e.data.message.isSystem=true;if(i===5)e.data.message.authorId=900;events.push(e);}
  f.store.ingest({events,nextOffset:6});await f.service.process();assert.equal(f.downloads,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM outbox').get().n,0);
});
test('successful OCR remains a review proposal until matching is connected',async t=>{
  const f=fixture(t);f.service.ocr={extract:async()=>({payments:[{amountCents:4000,currency:'RUB'}]})};
  f.store.ingest({events:[f.event()],nextOffset:2});await f.service.process();
  assert.equal(f.store.db.prepare('SELECT reason FROM inbox').get().reason,'MATCHING_NOT_CONNECTED');assert.equal(f.payments,0);
});
test('live matcher path persists proposal and replies without any CRM write',async t=>{
 const f=fixture(t);f.c.sendMessages=true;
 f.service.ocr={extract:async()=>({payments:[{payerName:'ООО Тест',amountCents:10000,currency:'RUB'}]})};
 f.api.request=async(path,method)=>{assert.equal(method,undefined);assert.match(path,/^\/items\/1078/);return {data:[{id:1,categoryId:31,stageId:'DT1078_31:CLIENT',currencyId:'RUB',ufCrm23_1768411333:'ООО Тест',ufCrm23_1770923673:'100|RUB'}],meta:{hasMore:false}};};
 f.store.ingest({events:[f.event()],nextOffset:2});await f.service.process();await f.service.deliver();
 assert.equal(f.store.db.prepare('SELECT reason FROM inbox').get().reason,'MATCHING_REVIEW');
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM matches').get().n,1);
 assert.equal(f.sends,1);assert.equal(f.payments,0);
 assert.match(f.store.db.prepare('SELECT text FROM outbox').get().text,/Сумма совпадает/);
});
test('send timeout is not retried; dry-run cannot call payment transport',async t=>{
  const f=fixture(t);f.c.sendMessages=true;let count=0;f.api.send=async()=>{count++;throw Error('after-delivery timeout');};
  f.store.ingest({events:[f.event()],nextOffset:2});await f.service.process();await f.service.deliver();await f.service.deliver();
  assert.equal(count,1);assert.equal(f.store.db.prepare('SELECT state FROM outbox').get().state,'uncertain');
  assert.equal((await f.service.submitPayment({invoiceId:2381,amountCents:4000})).status,'dry_run');assert.equal(f.payments,0);
});
test('Vibe payment adapter refuses writes by default before network',async t=>{
  const f=fixture(t);let calls=0;const v=new Vibe(f.c,'secret',async()=>{calls++;throw Error('network');});
  await assert.rejects(v.apply(2381,{stageId:'DT1078_31:SUCCESS',ufCrm23_1770921060:'40|RUB'}),/DISABLED/);assert.equal(calls,0);
});
test('Vibe adapter sends actual amount only and reports verified actor',async t=>{
  const f=fixture(t);f.c.crmWrites=true;let body;
  const v=new Vibe(f.c,'secret',async(url,options)=>{body=JSON.parse(options.body);return new Response(JSON.stringify({success:true,data:{id:2381}}));});v.actorId='49';
  assert.deepEqual(await v.apply(2381,{stageId:'DT1078_31:SUCCESS',ufCrm23_1770921060:'102.00|RUB'}),{accepted:true,actorId:'49'});
  assert.deepEqual(body,{stageId:'DT1078_31:SUCCESS',ufCrm23_1770921060:'102.00|RUB'});
  await assert.rejects(v.apply(999,{stageId:'DT1078_31:SUCCESS',ufCrm23_1770921060:'1|RUB'}),/DISABLED/);
});
test('download refuses unapproved URL before sending any key to file host',async t=>{
  const f=fixture(t);let calls=0;const v=new Vibe(f.c,'secret',async()=>{calls++;return new Response(JSON.stringify({success:true,data:{size:10,downloadUrl:'https://evil.invalid/a'}}));});
  await assert.rejects(v.download(7),/HOST_NOT_ALLOWED/);assert.equal(calls,1);
});
test('file request has no Vibe key and verifies magic bytes',async t=>{
  const f=fixture(t);let calls=0;const v=new Vibe(f.c,'secret',async(url,options)=>{
    if(++calls===1)return new Response(JSON.stringify({success:true,data:{size:8,downloadUrl:'https://example.invalid/download'}}));
    assert.equal(options.headers,undefined);return new Response(Buffer.from([137,80,78,71,13,10,26,10]));
  });assert.equal((await v.download(7)).mime,'image/png');
});
test('downloadUrl-only metadata accepts image but still limits actual stream size',async t=>{
  const f=fixture(t);let calls=0;
  const v=new Vibe(f.c,'secret',async()=>++calls%2===1?new Response(JSON.stringify({success:true,data:{downloadUrl:'https://example.invalid/download'}})):new Response(Buffer.from([137,80,78,71,13,10,26,10])));
  assert.equal((await v.download(7)).bytes.length,8);
  f.c.maxFileBytes=4;await assert.rejects(v.download(7),/FILE_TOO_LARGE/);
});
test('OCR rejects uncredited or invalid payments',async()=>{
  const ocr=new Ocr({url:'https://ocr.invalid'},async()=>new Response(JSON.stringify({payments:[{amountCents:100,currency:'RUB',direction:'incoming',status:'pending'}]})));
  await assert.rejects(ocr.extract({bytes:Buffer.from('image'),mime:'image/png'}),/NEEDS_REVIEW/);
});

test('initial selection, confirmation answers and updates preserve command buttons in Bitrix wire format',async()=>{
 const buttons=[{TEXT:'Счет 498',COMMAND:'payment_invoice_select',COMMAND_PARAMS:'token'}];
 const captured=[];
 const v=new Vibe({botId:75325,sendMessages:true,allowedDialogs:['chat1']},'test',async(url,options)=>{
  const body=JSON.parse(options.body);captured.push(body);
  const keyboard=body.fields?.keyboard??body.keyboard;
  if(keyboard!=='N')assert.deepEqual(keyboard,{BOT_ID:75325,BUTTONS:buttons});
  return new Response(JSON.stringify({success:true,data:{id:10}}));
 });
 await v.send('chat1','Выберите счет',buttons);
 await v.answerCommand('chat1','Подтвердите',{commandId:113,messageId:10},buttons);
 await v.request('/bots/75325/messages/10','PATCH',{message:'Выберите счет',keyboard:buttons});
 await v.request('/bots/75325/messages/10','PATCH',{keyboard:'N'});
 assert.equal(captured.length,4);assert.equal(captured[3].keyboard,'N');
 assert.equal(buttons[0].BOT_ID,undefined);
});
test('payment comments parse exact money and preserve unrelated comments for collision detection',async t=>{
  const f=fixture(t);const v=new Vibe(f.c,'secret',async()=>new Response(JSON.stringify({success:true,data:[
    {id:1,authorId:49,comment:'Внесена сумма по счету: 40.01|RUB\nДата следующего платежа:'},
    {id:2,authorId:83,comment:'other'}],meta:{hasMore:false}})));
  assert.deepEqual(await v.readComments(2381),[{id:'1',actorId:'49',amountCents:4001},{id:'2',actorId:'83',amountCents:null}]);
});
