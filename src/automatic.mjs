import {legalName} from './matching.mjs';
import {automaticInvoiceAllowed,automaticPartialAllowed} from './payment-scope.mjs';
import {paymentDate,paymentIdentity,bankReference,samePayment,paymentFallbackIdentity} from './payment-identity.mjs';
export {paymentDate} from './payment-identity.mjs';
const safe=value=>String(value??'').replace(/[\[\]<>\r\n]/g,' ').slice(0,180);
export function automaticCandidate(payment,match,policy,eventId,today){
 if(!policy?.enabled||Number(eventId)<policy.fromEventId)return null;
 const date=paymentDate(payment.date);
 if(!date||date<policy.fromDate||date>today||payment.currency!=='RUB'||payment.direction!=='incoming'||!Number.isSafeInteger(payment.amountCents)||payment.amountCents<=0)return null;
 const screenshot=policy.allowExactScreenshotPayments===true&&match.decisive===true;
 if(payment.status!=='credited'&&!(screenshot&&payment.status==null))return null;
 if(!bankReference(payment.bankReference)&&!screenshot)return null;
 if(match.decisive===true&&match.candidates.length===1&&automaticPartialAllowed(payment,match.candidates[0],policy,eventId))return match.candidates[0];
 const exact=match.candidates.filter(c=>c.nameExact&&c.amountMatch==='exact'&&c.numberMatch!=='different');
 if(exact.length!==1)return null;
 const selected=exact[0];
 // Same display name in different legal entities or recipient organizations is ambiguous.
 if(match.candidates.some(c=>c.companyId!==selected.companyId||c.mycompanyId!==selected.mycompanyId))return null;
 return selected;
}
export async function prepareAutomatic(service,job,context,payments,matches){
 const {config:c,store,vibe}=service,policy=c.automatic;
 const stop=(code,text,allowSelection=false)=>{for(const match of matches)match.review={code,text,allowSelection};return false;};
 const event=JSON.parse(job.body),instant=new Date(event.date??'');
 const today=Number.isFinite(instant.getTime())?new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(instant):null;
 if(!paymentDate(today))return stop('INVALID_EVENT_DATE','Не удалось определить дату сообщения. Требуется проверка исходного сообщения.');
 if(Number(job.id)<(policy?.fromEventId??0))return stop('OLD_EVENT','Это сообщение получено до включения проведения оплат. Старое сообщение автоматически не проводится.');
 const duplicate=store.db.prepare('SELECT 1 FROM artifacts a JOIN artifacts b ON a.hash=b.hash WHERE a.event_id=? AND b.event_id<>a.event_id LIMIT 1').get(job.id);
 if(duplicate)return stop('DUPLICATE_IMAGE','Это изображение уже поступало в бот. Повторная оплата заблокирована.');
 let queued=0;
 for(let index=0;index<payments.length;index++){
  const p=payments[index],match=matches[index],date=paymentDate(p.date),candidates=match.candidates??[];
  const review=(code,text,allowSelection=false,allowPayment=true)=>{match.review={code,text,allowSelection,allowPayment};};
  delete match.review;delete match.automaticQueued;
  if(!date){review('INVALID_PAYMENT_DATE','Дата поступления денег не определена. Дата счета не является датой платежа. Можно выбрать счет; для проведения укажите дату поступления денег.',true,false);continue;}
  if(date<(policy?.fromDate??'0000-01-01')||date>today){review('INVALID_PAYMENT_DATE','Дата поступления денег находится вне разрешенного периода. Требуется проверка документа.');continue;}
  const selected=automaticCandidate(p,match,policy,job.id,today),screenshot=!!selected&&policy?.allowExactScreenshotPayments===true&&match.decisive===true;
  if(p.currency==='RUB'&&p.direction==='incoming'&&p.status==null&&Number.isSafeInteger(p.amountCents)&&p.amountCents>0&&!screenshot){review('INCOMPLETE_EVIDENCE','Зачисление не подтверждено изображением. Выберите счет, затем подтвердите поступление денег кнопкой. Только это подтверждение разрешит проведение.',true,true);continue;}
  if(p.currency!=='RUB'||p.direction!=='incoming'||(p.status!=='credited'&&!(screenshot&&p.status==null))||!Number.isSafeInteger(p.amountCents)||p.amountCents<=0){review('INCOMPLETE_EVIDENCE','Не подтверждены сумма, валюта RUB или зачисление входящего платежа. Требуется проверка документа.');continue;}
  const allowed=candidates.filter(candidate=>automaticInvoiceAllowed(c,candidate)&&(!c.recipientCompanyIds||c.recipientCompanyIds.includes(candidate.mycompanyId)));
  if(candidates.length&&!allowed.length){review('OUTSIDE_SCOPE','Найденные счета находятся вне разрешенного контура проведения оплат.');continue;}
  const identities=allowed.map(candidate=>paymentIdentity(p,candidate)).filter(Boolean);
  const priorPayments=store.db.prepare('SELECT source_event,payment_index,body FROM payment_dialogs').all().filter(row=>row.source_event!==job.id||row.payment_index!==index).map(row=>JSON.parse(row.body));
  if(priorPayments.some(prior=>allowed.some(candidate=>samePayment(p,candidate,prior.payment,prior.selected)))||[...identities,...allowed.map(candidate=>paymentFallbackIdentity(p,candidate))].filter(Boolean).some(identity=>service.journal?.db.prepare('SELECT id FROM operations WHERE fingerprint=?').get(identity))){review('DUPLICATE_PAYMENT','Этот банковский платеж уже поступал в обработку. Повторная оплата заблокирована.');continue;}
  if(match.decisive&&matches.some((other,j)=>j!==index&&other.decisive&&other.candidates[0]?.id===candidates[0]?.id)){review('BATCH_INVOICE_CONFLICT','Элемент однозначно найден по номерам счетов. Несколько платежей относятся к одному элементу; требуется сверить их общую сумму с остатком и ранее учтенными оплатами.',true,false);continue;}
  if(match.decisive&&['overpayment','unknown'].includes(candidates[0]?.amountMatch)){review('BALANCE_CONFLICT','Элемент однозначно найден по номеру счета. Сумма превышает остаток либо остаток неизвестен; проведение остановлено до сверки данных CRM.',true,false);continue;}
  if(!bankReference(p.bankReference)&&!screenshot){review('MISSING_BANK_REFERENCE',match.decisive?'Элемент однозначно найден по номеру счета. Номер банковской операции не виден; подтвердите поступление через кнопку найденного счета.':'Платеж распознан без номера банковской операции. Выберите счет и подтвердите поступление: подтверждение запустит оплату с проверкой повторов по счету, дате, сумме и сторонам платежа.',true);continue;}
  if(!c.crmWrites){review('WRITES_DISABLED','Запись оплат в CRM отключена. Можно выбрать счет для проверки.',true);continue;}
  if(!policy?.enabled){review('AUTOMATIC_DISABLED','Автоматическое проведение отключено. Выберите счет для ручного подтверждения.',true);continue;}
  if(!selected){review('NONEXACT_MATCH',match.decisive&&candidates[0]?.amountMatch==='partial'?'Счет однозначно найден по юрлицу и номеру из назначения. Условия автоматической оплаты не выполнены; выберите найденный счет для проверки.':'Нет однозначного совпадения по данным платежа. Выберите подходящий счет для проверки.',true);continue;}
  if(!automaticInvoiceAllowed(c,selected)||(c.recipientCompanyIds&&!c.recipientCompanyIds.includes(selected.mycompanyId))){review('OUTSIDE_SCOPE','Выбранный счет находится вне разрешенного контура проведения оплат.');continue;}
  if(payments.some((other,j)=>j!==index&&automaticCandidate(other,matches[j],policy,job.id,today)?.id===selected.id)){review('BATCH_INVOICE_CONFLICT','Несколько строк относятся к одному счету. Требуется проверить распределение суммы.',true,false);continue;}
  let own;try{own=(await vibe.request('/companies/'+selected.mycompanyId)).data;}catch{review('RECIPIENT_UNAVAILABLE','Не удалось проверить получателя по данным CRM. Требуется повторная проверка выбранного счета.',true);continue;}
  if(!own?.title){review('RECIPIENT_UNAVAILABLE','В CRM отсутствует название получателя. Требуется проверка выбранного счета.',true);continue;}
  if(p.recipientName&&legalName(own.title)!==legalName(p.recipientName)){review('RECIPIENT_CONFLICT',`На изображении получатель «${safe(p.recipientName)}», а в выбранном счете — «${safe(own.title)}». Уточните получателя перед подтверждением.`,true);continue;}
 // Recipient is taken from the uniquely matched CRM invoice, per user instruction.
 // An explicitly visible conflicting name still requires clarification.
 const body={payment:p,selected:{...selected,recipientConfirmed:true},candidates,recipientName:own.title,recipientSource:'matched_crm_invoice',
  autoAuthorization:{rule:selected.amountMatch==='partial'?'numbered-partial-v1':screenshot?'exact-screenshot-v3':'exact-client-balance-v2',eventId:job.id,at:new Date().toISOString()},paymentAuthorizedOnConfirm:false};
 let inserted=store.db.prepare('INSERT OR IGNORE INTO payment_dialogs VALUES(?,?,?,?,?,?)').run(job.id,index,context.dialog,context.author,'review_ready',JSON.stringify(body));
 if(!inserted.changes){
  const existing=store.db.prepare('SELECT * FROM payment_dialogs WHERE source_event=? AND payment_index=?').get(job.id,index),old=existing&&JSON.parse(existing.body);
  if(existing?.state==='awaiting_invoice'&&existing.author===context.author&&existing.dialog===context.dialog&&!old.selected&&!old.recipientReply&&!old.paymentSpec&&!old.rejectedBy&&JSON.stringify(old.payment)===JSON.stringify(p)){
   inserted=store.db.prepare("UPDATE payment_dialogs SET state='review_ready',body=? WHERE source_event=? AND payment_index=? AND state='awaiting_invoice' AND body=?").run(JSON.stringify(body),job.id,index,existing.body);
  }
 }
 if(!inserted.changes){review('ALREADY_QUEUED','Этот платеж уже поставлен в обработку. Повторная оплата не отправляется.');continue;}
 queued++;match.automaticQueued=true;review('AUTO_PAYMENT_QUEUED','Счет однозначно найден. Оплата обрабатывается автоматически; подтверждение не требуется.',false,false);
 }
 return payments.length>0&&queued===payments.length;
}
