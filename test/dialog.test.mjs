import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.mjs';
import {handleReply,prepareChoiceButtons} from '../src/dialog.mjs';
import {matchPayment} from '../src/matching.mjs';
import {prepareAutomatic} from '../src/automatic.mjs';

test('missing bank reference keeps invoice buttons and confirmation authorizes payment',async t=>{
 const f=setup(t),payment={...f.payment,date:'2026-09-22',direction:'incoming',status:'credited',bankReference:null};
 const matches=[matchPayment(payment,[f.item])];
 const config={crmWrites:true,invoiceAllowlist:[2309],automatic:{enabled:true,fromEventId:0,fromDate:'2026-09-18'}};
 assert.equal(await prepareAutomatic({store:f.store,vibe:f.api,config},{id:'7',body:JSON.stringify({date:'2026-09-22'})},{dialog:'49',author:49},[payment],matches),false);
 const buttons=prepareChoiceButtons(f.store,{id:'7'},{dialog:'49',author:49},[payment],matches);
 assert.equal(buttons.length,1);
 f.store.db.prepare('INSERT INTO inbox(id,body) VALUES(?,?)').run('11','{}');
 await handleReply(f.store,f.api,{id:'11'},{dialog:'49',author:49,text:'Выбрать счет '+buttons[0].COMMAND_PARAMS},config);
 const reply=f.store.db.prepare('SELECT * FROM outbox WHERE event_id=?').get('11');
 assert.match(reply.text,/Подтверждение запустит/);
 const confirm=JSON.parse(reply.keyboard)[0];
 f.store.db.prepare('INSERT INTO inbox(id,body) VALUES(?,?)').run('12','{}');
 await handleReply(f.store,f.api,{id:'12'},{dialog:'49',author:49,text:'Подтвердить выбор '+confirm.COMMAND_PARAMS},config);
 const body=JSON.parse(f.store.db.prepare('SELECT body FROM payment_dialogs').get().body);
 assert.equal(body.paymentAuthorizedOnConfirm,true);assert.equal(body.selected.recipientConfirmed,true);
});
function setup(t){
 const dir=mkdtempSync(join(tmpdir(),'dialog-')),path=join(dir,'db');let store=new Store(path);
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 const payment={payerName:'ЗАО Демо Альфа',amountCents:24640000,currency:'RUB'};
 const item={id:2309,categoryId:31,stageId:'DT1078_31:CLIENT',companyId:10,mycompanyId:2281,currencyId:'RUB',ufCrm23_1768411333:'ЗАО Демо Альфа',ufCrm23_1768411703:'492',ufCrm23_1770923673:'246400|RUB'};
 store.ingest({events:[{eventId:7,type:'ONIMBOTV2MESSAGEADD',data:{message:{authorId:49},chat:{dialogId:'49'}}}],nextOffset:8});
 store.db.prepare('INSERT INTO extracted VALUES(?,?,?)').run('7',1,JSON.stringify({payments:[payment]}));
 store.db.prepare('INSERT INTO matches VALUES(?,?)').run('7',JSON.stringify({matches:[matchPayment(payment,[item])]}));
 const api={read:async()=>item,request:async p=>{assert.equal(p,'/companies/2281');return {data:{title:'ИП Примеров'}};}};
 const send=async(id,text,overrides={})=>{store.db.prepare('INSERT OR IGNORE INTO inbox(id,body) VALUES(?,?)').run(String(id),'{}');await handleReply(store,api,{id:String(id)},{dialog:'49',author:49,text,...overrides});return store.db.prepare('SELECT * FROM outbox WHERE event_id=?').get(String(id));};
 return {api,payment,get store(){return store;},item,send,restart(){store.close();store=new Store(path);}};
}

test('unknown credited status stays unknown until the bound confirmation button is used',async t=>{
 const f=setup(t),payment={...f.payment,date:'2026-09-22',direction:'incoming',status:null,bankReference:null};
 const matches=[matchPayment(payment,[f.item])],config={crmWrites:true,invoiceAllowlist:[2309],automatic:{enabled:true,fromEventId:1,fromDate:'2026-09-18'}};
 await prepareAutomatic({store:f.store,vibe:f.api,config},{id:'7',body:JSON.stringify({date:'2026-09-22'})},{dialog:'49',author:49},[payment],matches);
 const buttons=prepareChoiceButtons(f.store,{id:'7'},{dialog:'49',author:49},[payment],matches);
 const send=async(id,text)=>{f.store.db.prepare('INSERT INTO inbox(id,body) VALUES(?,?)').run(id,'{}');await handleReply(f.store,f.api,{id},{dialog:'49',author:49,text},config);return f.store.db.prepare('SELECT * FROM outbox WHERE event_id=?').get(id);};
 const selected=await send('11','Выбрать счет '+buttons[0].COMMAND_PARAMS);
 assert.equal(JSON.parse(f.store.db.prepare('SELECT body FROM payment_dialogs').get().body).payment.status,null);
 await send('12','да');assert.equal(f.store.db.prepare('SELECT state FROM payment_dialogs').get().state,'awaiting_recipient');
 await send('13','Подтвердить выбор '+JSON.parse(selected.keyboard)[0].COMMAND_PARAMS);
 const row=f.store.db.prepare('SELECT * FROM payment_dialogs').get(),body=JSON.parse(row.body);
 assert.equal(row.state,'review_ready');assert.equal(body.payment.status,'credited');assert.equal(body.payment.statusSource.kind,'user_button_confirmation');assert.equal(body.payment.statusSource.event,'13');
});
test('text selection persists through restart, button confirms only this choice and replay is harmless',async t=>{
 const f=setup(t);const reply=await f.send(11,'счет 492');assert.match(reply.text,/Выбран счет/);const buttons=JSON.parse(reply.keyboard);assert.equal(buttons.length,2);
 f.restart();await f.send(12,'Подтвердить выбор '+buttons[0].COMMAND_PARAMS);
 assert.equal(f.store.db.prepare('SELECT state FROM payment_dialogs').get().state,'review_ready');
 const replay=await f.send(13,'Подтвердить выбор '+buttons[0].COMMAND_PARAMS);assert.match(replay.text,/уже обработана/);
});
test('reject clears selection, stale confirmation cannot resurrect it',async t=>{
 const f=setup(t),buttons=JSON.parse((await f.send(11,'счте 492')).keyboard);
 await f.send(12,'Отклонить выбор '+buttons[1].COMMAND_PARAMS);
 assert.equal(f.store.db.prepare('SELECT state FROM payment_dialogs').get().state,'awaiting_invoice');
 assert.equal(JSON.parse(f.store.db.prepare('SELECT body FROM payment_dialogs').get().body).selected,null);
 assert.match((await f.send(13,'Подтвердить выбор '+buttons[0].COMMAND_PARAMS)).text,/устарела/);
});
test('other user cannot use choice; changed invoice cannot be confirmed',async t=>{
 const f=setup(t),buttons=JSON.parse((await f.send(11,'492')).keyboard);
 await f.send(12,'Подтвердить выбор '+buttons[0].COMMAND_PARAMS,{author:83});
 assert.equal(f.store.db.prepare('SELECT state FROM payment_dialogs').get().state,'awaiting_recipient');
 f.item.ufCrm23_1770923673='1|RUB';assert.match((await f.send(13,'Подтвердить выбор '+buttons[0].COMMAND_PARAMS)).text,/изменился/);
 assert.equal(f.store.db.prepare('SELECT state FROM payment_dialogs').get().state,'awaiting_recipient');
});

test('invoice buttons bind exact element and payment, persist and reject repeated selection',async t=>{
 const f=setup(t);f.api.read=async id=>({...f.item,id});
 const matches=[matchPayment(f.payment,[f.item,{...f.item,id:2310}])];
 const buttons=prepareChoiceButtons(f.store,{id:'7'},{dialog:'49',author:49},[f.payment],matches);
 assert.equal(buttons.length,2);assert.equal(buttons[1].COMMAND,'payment_invoice_select');assert.match(buttons[1].TEXT,/2310/);
 f.restart();await f.send(10,'Выбрать счет '+buttons[1].COMMAND_PARAMS,{author:83});
 assert.equal(f.store.db.prepare('SELECT state FROM payment_dialogs').get().state,'awaiting_invoice');
 const reply=await f.send(11,'Выбрать счет '+buttons[1].COMMAND_PARAMS);
 assert.equal(JSON.parse(f.store.db.prepare('SELECT body FROM payment_dialogs').get().body).selected.id,2310);assert.match(reply.text,/details\/2310/);
 assert.match((await f.send(12,'Выбрать счет '+buttons[0].COMMAND_PARAMS)).text,/устарела/);
 await f.send(13,'Подтвердить выбор '+JSON.parse(reply.keyboard)[0].COMMAND_PARAMS);
 assert.equal(f.store.db.prepare('SELECT state FROM payment_dialogs').get().state,'review_ready');
});
