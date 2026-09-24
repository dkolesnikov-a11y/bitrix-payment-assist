import {matchPayment,legalName} from './matching.mjs';
import {randomUUID} from 'node:crypto';
import {isTeam,teamAuthorized} from './team.mjs';
import {automaticInvoiceAllowed} from './payment-scope.mjs';
const safe=x=>String(x??'').replace(/[\[\]<>\r\n]/g,' ').slice(0,180);
export function invoiceChoice(text){
 const m=String(text).trim().match(/^(?:(?:сч[её]т|счте|счету)\s*)?(?:№\s*)?([\p{L}\p{N}][\p{L}\p{N}/_-]*)[.!]?$/iu);
 return m?m[1].toUpperCase():null;
}
export function prepareChoiceButtons(store,job,context,payments,matches){
 const keyboard=[];
 store.tx(()=>{matches.forEach((match,index)=>{
  if(!match.candidates.length||match.review?.allowSelection===false)return;
  const choices=match.candidates.slice(0,5).map(c=>({token:randomUUID(),id:c.id}));
  store.db.prepare('INSERT OR IGNORE INTO payment_dialogs VALUES(?,?,?,?,?,?)').run(job.id,index,context.dialog,context.author,'awaiting_invoice',JSON.stringify({payment:payments[index],candidates:match.candidates,choices,review:match.review}));
  const row=store.db.prepare('SELECT body,state FROM payment_dialogs WHERE source_event=? AND payment_index=?').get(job.id,index);
  if(row.state!=='awaiting_invoice')return;
  const body=JSON.parse(row.body);
  for(const choice of body.choices??[]){const c=body.candidates.find(c=>c.id===choice.id);keyboard.push({TEXT:`${matches.length>1?'Платеж '+(index+1)+' · ':''}Счет № ${safe(c.number)} · ID ${c.id}`,COMMAND:'payment_invoice_select',COMMAND_PARAMS:choice.token,BLOCK:'Y',BG_COLOR_TOKEN:'primary'});}
 });});
 return keyboard.length?keyboard:undefined;
}
function seed(store,job,context,fromEvent=0,config={}){
 const rows=store.db.prepare('SELECT m.event_id,m.body,i.body source FROM matches m JOIN inbox i ON i.id=m.event_id WHERE CAST(m.event_id AS INTEGER) < ?').all(Number(job.id));
 for(const row of rows){
  if(Number(row.event_id)<=fromEvent)continue;
  const source=JSON.parse(row.source),d=source.data;
  const routed=store.db.prepare('SELECT target_dialog FROM image_routes WHERE event_id=?').get(row.event_id);
  if((routed?.target_dialog??d.chat?.dialogId??d.dialogId)!==context.dialog)continue;
  if(isTeam(config,context.dialog)?!config.uploadUsers.includes(d.message?.authorId):d.message?.authorId!==context.author)continue;
  const payments=store.db.prepare('SELECT body FROM extracted WHERE event_id=? ORDER BY file_id').all(row.event_id).flatMap(x=>JSON.parse(x.body).payments);
  JSON.parse(row.body).matches.forEach((match,index)=>{
   if(!match.candidates?.length||!payments[index]||match.review?.allowSelection===false)return;
   store.db.prepare('INSERT OR IGNORE INTO payment_dialogs VALUES(?,?,?,?,?,?)').run(row.event_id,index,context.dialog,d.message.authorId,'awaiting_invoice',JSON.stringify({payment:payments[index],candidates:match.candidates,review:match.review}));
  });
 }
}
export async function handleReply(store,vibe,job,context,config={}){
 const canPay=invoice=>config.crmWrites===true&&automaticInvoiceAllowed(config,invoice);
 const shared=isTeam(config,context.dialog);
 if(shared&&!await teamAuthorized(vibe,config,context.author))return;
 seed(store,job,context,shared?0:config.accessFromEvents?.[context.author]??0,config);
 const rows=shared?store.db.prepare('SELECT * FROM payment_dialogs WHERE dialog=? AND CAST(source_event AS INTEGER) < ?').all(context.dialog,Number(job.id)):store.db.prepare('SELECT * FROM payment_dialogs WHERE dialog=? AND author=? AND CAST(source_event AS INTEGER) < ?').all(context.dialog,context.author,Number(job.id));
 const answer=(text,reason='DIALOG_CLARIFY',row=null,body=null,state=null,keyboard=null)=>store.finish(job.id,'done',reason,{dialog:context.dialog,text,keyboard,commandReply:context.commandReply},row?()=>{
  store.db.prepare('UPDATE payment_dialogs SET body=?,state=? WHERE source_event=? AND payment_index=?').run(JSON.stringify(body),state,row.source_event,row.payment_index);
 }:undefined);
 if(!rows.length){answer('Пришлите скриншот зачисления. Ожидающего выбора счета в этом чате нет.','NO_IMAGE');return;}
 const action=context.text.trim().match(/^(Подтвердить выбор|Отклонить выбор) ([a-f0-9-]{36})$/u);
 let bound=null;
 if(action){
  bound=rows.find(r=>JSON.parse(r.body).token===action[2]&&r.state==='awaiting_recipient');
  if(!bound){answer('Эта кнопка уже обработана или устарела. Новая оплата по этому нажатию не отправлялась.');return;}
  if(action[1]==='Отклонить выбор'){
   const body=JSON.parse(bound.body);answer('Выбор счета отклонен. Укажите другой номер счета; скриншот повторять не нужно. Оплата не проводилась.','INVOICE_REJECTED',bound,{...body,selected:null,token:null,recipientReply:null,rejectedBy:{author:context.author,event:job.id}},'awaiting_invoice');return;
  }
 }
 const choice=invoiceChoice(context.text);
 const options=[];
 const selection=context.text.trim().match(/^Выбрать счет ([a-f0-9-]{36})$/u);
 if(selection){
  for(const row of rows){if(row.state!=='awaiting_invoice')continue;const body=JSON.parse(row.body);const selected=body.choices?.find(x=>x.token===selection[1]);const c=selected&&body.candidates.find(x=>x.id===selected.id);if(c&&(!config.recipientCompanyIds||config.recipientCompanyIds.includes(c.mycompanyId)))options.push({row,body,c});}
  if(options.length!==1){answer('Эта кнопка выбора уже обработана или устарела. Новая оплата не отправлялась.');return;}
 }
 for(const row of rows){if(row.state!=='awaiting_invoice'&&row.state!=='awaiting_recipient')continue;const body=JSON.parse(row.body);for(const c of body.candidates)if((!config.recipientCompanyIds||config.recipientCompanyIds.includes(c.mycompanyId))&&choice&&String(c.number).toUpperCase()===choice)options.push({row,body,c});}
 if(options.length===1){
  const {row,body,c}=options[0];
  if(body.review?.code==='MISSING_BANK_REFERENCE')body.review={...body.review,allowPayment:true,text:'Номер банковской операции не виден. После подтверждения платеж будет проведен с проверкой повторов по счету, дате, сумме и сторонам платежа.'};
  const current=await vibe.read(c.id);
  const fresh=matchPayment(body.payment,[{...current,companyTitle:c.legalName}]).candidates.find(x=>x.id===c.id);
  if(!fresh||fresh.companyId!==c.companyId||fresh.mycompanyId!==c.mycompanyId||fresh.balanceCents!==c.balanceCents){answer('Данные счета изменились с момента подбора. Выбор не подтвержден; требуется повторная проверка. Оплата не проводилась.','DIALOG_STALE');return;}
  const company=(await vibe.request('/companies/'+fresh.mycompanyId)).data;
  if(!company?.title)throw Error('RECIPIENT_UNAVAILABLE');
  const paymentAllowed=canPay(fresh)&&body.review?.allowPayment!==false;
  const token=randomUUID(),next={...body,selected:fresh,recipientName:company.title,selectedByEvent:job.id,selectedByAuthor:context.author,recipientReply:null,token,requireButtonForPayment:shared||body.requireButtonForPayment||(body.payment.status==null&&body.review?.code==='INCOMPLETE_EVIDENCE'),paymentAuthorizedOnConfirm:paymentAllowed};
  const keyboard=[{TEXT:'Подтвердить выбор',COMMAND:'payment_choice_confirm',COMMAND_PARAMS:token,BLOCK:'Y',BG_COLOR_TOKEN:'primary'},{TEXT:'Отклонить выбор',COMMAND:'payment_choice_reject',COMMAND_PARAMS:token,BLOCK:'Y',BG_COLOR_TOKEN:'secondary'}];
  answer(`Выбран счет № ${safe(fresh.number)} на ${(body.payment.amountCents/100).toFixed(2)} ₽.\nhttps://example.invalid/crm/type/1078/details/${fresh.id}/\nВ счете получатель: ${safe(company.title)}.\n${body.review?.text?body.review.text+"\n":""}Если счет верный и деньги поступили этой организации, нажмите «Подтвердить выбор». Иначе — «Отклонить выбор».\n${paymentAllowed?'Подтверждение запустит проведение оплаты по этому счету.':'Кнопки сохраняют выбор, оплату пока не проводят.'}`, 'INVOICE_SELECTED',row,next,'awaiting_recipient',keyboard);return;
 }
 if(options.length>1){answer('Этот номер подходит нескольким ожидающим платежам. Выбор не сохранен: требуется уточнить исходный платеж. Оплата не проводилась.');return;}
 const waiting=bound?[bound]:rows.filter(r=>r.state==='awaiting_recipient');
 if(waiting.length===1){
  const row=waiting[0],body=JSON.parse(row.body),text=context.text.trim();
  if(body.requireButtonForPayment&&!bound){answer('Для проведения этого платежа используйте кнопку в сообщении с суммой и счетом. Текстовый ответ не запускает оплату.');return;}
  if(bound||/^(?:да|верно|подтверждаю)[.!]?$/iu.test(text)||legalName(text)===legalName(body.recipientName)){
   const current=await vibe.read(body.selected.id);
   if(config.recipientCompanyIds&&!config.recipientCompanyIds.includes(Number(current.mycompanyId))){answer('Получатель счета вне разрешенного списка. Оплата не проводилась.');return;}
   const fresh=matchPayment(body.payment,[{...current,companyTitle:body.selected.legalName}]).candidates[0];
   if(!fresh||fresh.balanceCents!==body.selected.balanceCents||fresh.mycompanyId!==body.selected.mycompanyId||fresh.companyId!==body.selected.companyId){answer('Счет изменился. Подтверждение не принято, оплата не проводилась.','DIALOG_STALE');return;}
   if(bound&&body.payment.status==null&&body.review?.code==='INCOMPLETE_EVIDENCE'&&body.paymentAuthorizedOnConfirm){
    body.payment={...body.payment,status:'credited',statusSource:{kind:'user_button_confirmation',author:context.author,event:job.id}};
   }
   answer(`Получатель подтвержден: ${safe(body.recipientName)}. Выбор счета № ${safe(body.selected.number)} сохранен.\n${canPay(body.selected)&&body.paymentAuthorizedOnConfirm?'Проверяю проведение оплаты. Дождитесь отдельного сообщения о результате.':'Оплата не проведена: проведение для этого выбора не включено. Повторять скриншот не нужно.'}`, 'RECIPIENT_CONFIRMED',row,{...body,recipientReply:{event:job.id,author:context.author,at:new Date().toISOString()},selected:{...body.selected,recipientConfirmed:true}},'review_ready');return;
  }
  answer(`По счету № ${safe(body.selected.number)} получатель — ${safe(body.recipientName)}. Если деньги пришли другой организации, выбранный счет требует проверки. Оплата не проводилась. Ответьте «да», только если получатель совпадает.`);return;
 }
 const pending=rows.filter(r=>['review_ready','payment_pending'].includes(r.state));
 if(pending.length){answer(config.crmWrites?'Подтверждение принято. Платеж ожидает обработки или проверки результата в CRM. Дождитесь итогового сообщения; повторять подтверждение не нужно.':'Подтверждение сохранено. Запись в CRM сейчас выключена; оплата не отправлялась.','PAYMENT_STATUS');return;}
 if(rows.every(r=>r.state==='paid')){answer('Платежи уже обработаны. Результаты и ссылки на счета опубликованы в итоговых сообщениях. Новая оплата не отправлялась.','PAYMENT_STATUS');return;}
 answer('Уточните номер счета, например «счёт 492». Скриншот повторно присылать не нужно. Оплата не проводилась.');
}
