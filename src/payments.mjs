import {paymentIdentity,paymentFallbackIdentity,samePayment,bankReference} from './payment-identity.mjs';
import {snapshot,paymentStartStages} from '../tools/payment-safety/guard.mjs';
import {isTeam,teamMembers} from './team.mjs';
import {automaticInvoiceAllowed,automaticPartialAllowed} from './payment-scope.mjs';
// Compare old raw fingerprints through their original dialog evidence. Never rewrite
// historical intents or retry a dispatched/uncertain operation under a new identity.
function priorPayment(store,journal,row,identity,payment,selected){
 if(journal.db.prepare('SELECT id FROM operations WHERE fingerprint=?').get(identity))return true;
 const fallback=paymentFallbackIdentity(payment,selected);
 if(fallback&&journal.db.prepare('SELECT id FROM operations WHERE fingerprint=?').get(fallback))return true;
 for(const prior of store.db.prepare('SELECT source_event,payment_index,state,body FROM payment_dialogs').all()){
  if(prior.source_event===row.source_event&&prior.payment_index===row.payment_index)continue;
  const body=JSON.parse(prior.body);
  if(!body.paymentSpec&&!['paid','payment_pending'].includes(prior.state))continue;
  if(samePayment(payment,selected,body.payment,body.selected))return true;
 }
 return false;
}
export async function processPayments(service){
 const {config:c,store,vibe,journal,guard}=service;
 if(!c.crmWrites)return;
 const rows=store.db.prepare("SELECT * FROM payment_dialogs WHERE state IN ('review_ready','payment_pending')").all();
 for(const row of rows){
  let body=JSON.parse(row.body),selected=body.selected,p=body.payment;
  const automaticScreenshot=body.autoAuthorization?.rule==='exact-screenshot-v3'&&c.automatic?.allowExactScreenshotPayments===true&&c.automatic?.enabled===true&&Number(row.source_event)>=c.automatic.fromEventId&&selected?.nameExact===true&&selected?.amountMatch==='exact'&&['exact','suffix'].includes(selected?.numberMatch);
  const automaticPartial=body.autoAuthorization?.rule==='numbered-partial-v1'&&automaticPartialAllowed(p,selected,c.automatic,row.source_event);
  const automatic=automaticPartial||automaticScreenshot||body.autoAuthorization?.rule==='exact-client-balance-v2'&&c.automatic?.enabled===true&&Number(row.source_event)>=c.automatic.fromEventId;
  if(!selected||!(c.invoiceAllowlist.includes(selected.id)||(automatic||body.paymentAuthorizedOnConfirm)&&automaticInvoiceAllowed(c,selected))||!c.allowedUsers.includes(row.author)||!c.allowedDialogs.includes(row.dialog))continue;
  if(c.recipientCompanyIds&&!c.recipientCompanyIds.includes(selected.mycompanyId))continue;
  if(!body.paymentAuthorizedOnConfirm&&!automatic)continue;
  const save=(state,reason,text)=>store.tx(()=>{
   body.paymentResult={state,reason};
   store.db.prepare('UPDATE payment_dialogs SET state=?,body=? WHERE source_event=? AND payment_index=?').run(state,JSON.stringify(body),row.source_event,row.payment_index);
   if(text)store.db.prepare('INSERT OR IGNORE INTO outbox(id,event_id,dialog,text) VALUES(?,?,?,?)').run(`payment:${row.source_event}:${row.payment_index}:${state}`,row.source_event,row.dialog,text);
  });
  let spec=body.paymentSpec;
  if(isTeam(c,row.dialog)&&(!spec||!journal.get(spec.id))){
   let members;try{members=await teamMembers(vibe,c);}catch{continue;}
   if(!c.uploadUsers.includes(row.author)||!members.includes(row.author))continue;
   if(!automatic&&!members.includes(body.recipientReply?.author)){
    delete body.recipientReply;
    store.tx(()=>{
     store.db.prepare("UPDATE payment_dialogs SET state='awaiting_recipient',body=? WHERE source_event=? AND payment_index=?").run(JSON.stringify(body),row.source_event,row.payment_index);
     store.db.prepare('INSERT OR IGNORE INTO outbox(id,event_id,dialog,text) VALUES(?,?,?,?)').run(`revoked:${row.source_event}:${row.payment_index}`,row.source_event,row.dialog,'Сотрудник, подтвердивший платеж, больше не участвует в чате. Оплата не отправлялась. Требуется подтверждение текущего участника кнопкой у выбранного счета.');
    });continue;
   }
  }
  if(!spec||!journal.get(spec.id)){
   const identity=paymentIdentity(p,selected);
   if(!identity){save('payment_blocked','INCOMPLETE_EVIDENCE','Проведение остановлено: дата или реквизиты платежа не распознаны однозначно. Оплата не отправлялась.');continue;}
   if(priorPayment(store,journal,row,identity,p,selected)){save('payment_blocked','DUPLICATE','Этот платеж уже есть в журнале или ожидает проверки. Повторная запись не выполнялась.');continue;}
  }
  if(!spec){
   if(!selected.recipientConfirmed||(!body.recipientReply&&!automatic)||(!bankReference(p.bankReference)&&!automaticScreenshot&&!automaticPartial&&(!body.recipientReply||automatic))||p.currency!=='RUB'||p.direction!=='incoming'||(p.status!=='credited'&&!(automaticScreenshot&&p.status==null))||!p.date){save('payment_blocked','INCOMPLETE_EVIDENCE','Проведение остановлено: не хватает подтвержденных данных платежа. Оплата не отправлялась.');continue;}
   let before;
   try{before=snapshot(await vibe.read(selected.id));}catch{save('payment_blocked','READ_FAILED','Не удалось проверить счет перед оплатой. Оплата не отправлялась.');continue;}
   if(before.companyId!==selected.companyId||before.mycompanyId!==selected.mycompanyId||before.balanceCents!==selected.balanceCents||!paymentStartStages.has(before.stage)||!Number.isSafeInteger(p.amountCents)||p.amountCents<=0||p.amountCents>before.balanceCents||(automaticScreenshot&&p.amountCents!==before.balanceCents)){save('payment_blocked','PRECONDITION','Проведение остановлено: счет изменился или этот вариант оплаты пока не проверен. Оплата не отправлялась.');continue;}
   const fingerprint=paymentIdentity(p,before);
   const old=journal.db.prepare('SELECT id FROM operations WHERE fingerprint=?').get(fingerprint);
   if(old){save('payment_blocked','DUPLICATE','Этот платеж уже есть в журнале. Повторная запись не выполнялась.');continue;}
   spec={id:'chat_'+fingerprint,fingerprint,invoiceId:selected.id,parentId:before.parentId,amountCents:p.amountCents,before,origin:{chatId:row.dialog,messageId:row.source_event}};
   body.paymentSpec=spec;
   // Durable intent before any remote mutation. Restart must reuse this exact spec.
   store.db.prepare("UPDATE payment_dialogs SET state='payment_pending',body=? WHERE source_event=? AND payment_index=?").run(JSON.stringify(body),row.source_event,row.payment_index);
  }
  let op;
  try{op=journal.get(spec.id)??await guard.execute(spec);}catch{save('payment_pending','CHECK_REQUIRED','Результат требует проверки по журналу. Повторная отправка оплаты запрещена.');continue;}
  if(op.status==='confirmed'){
   const balance=op.evidence?.after?.balanceCents;
   const result=op.reason==='OPERATOR_CONFIRMED'?'Проведение подтверждено оператором.': 'Результат проверен в CRM.';
   const remainder=Number.isSafeInteger(balance)&&balance>=0?` Остаток: ${(balance/100).toFixed(2)} ₽.`:'';
   save('paid','CONFIRMED',`Оплата ${(spec.amountCents/100).toFixed(2)} ₽ по счету № ${selected.number} проведена.${remainder} ${result}\nhttps://example.invalid/crm/type/1078/details/${selected.id}/`);
  }
  else if(op.status==='rejected')save('payment_blocked',op.reason,'Счет изменился перед отправкой. Оплата не отправлялась.');
  else save('payment_pending',op.reason,'Запрос оплаты сохранен. Бот проверяет результат в CRM; повторно отправлять платеж не нужно.');
 }
}
