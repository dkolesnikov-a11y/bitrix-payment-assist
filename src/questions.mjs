// Read-only answers: a question never confirms or retries a payment.
import {cents} from '../tools/payment-safety/guard.mjs';
const safe=value=>String(value??'').replace(/[\[\]<>\r\n]/g,' ').slice(0,160);
export function isPaymentQuestion(text){
 return /\?|^(?:почему|зачем|когда|как|какой|какая|какие|что|где|статус|проверь)(?:\s|$)/iu.test(text.trim());
}
export async function answerQuestion(store,vibe,job,context){
 const reply=text=>store.finish(job.id,'done','QUESTION_ANSWERED',{dialog:context.dialog,text});
 const source=context.replyTo&&store.db.prepare("SELECT event_id FROM outbox WHERE remote_id=? AND dialog=? AND state='sent'").get(String(context.replyTo),context.dialog);
 if(!source){reply('Чтобы проверить конкретный платеж или стадию сделки, ответьте на сообщение бота об этом платеже и задайте вопрос с @упоминанием. Для проведения используйте кнопки выбора и подтверждения счета.');return;}
 const rows=store.db.prepare('SELECT state,body FROM payment_dialogs WHERE source_event=? AND dialog=?').all(source.event_id,context.dialog);
 if(rows.length!==1){reply('В исходном сообщении нет единственного выбранного платежа. Уточните счет или ответьте на сообщение с результатом конкретной оплаты.');return;}
 const row=rows[0],body=JSON.parse(row.body),selected=body.selected;
 if(!selected){reply(body.review?.text??'Счет еще не выбран. Используйте кнопку счета в исходном сообщении, затем подтвердите поступление.');return;}
 try{
  const invoice=await vibe.read(selected.id);
  const lines=[`Счет № ${safe(selected.number)}: ${invoice.stageId==='DT1078_31:SUCCESS'?'оплачен':`стадия ${safe(invoice.stageId)}`}, остаток ${(cents(invoice.ufCrm23_1770923673)/100).toFixed(2)} ₽.`,
   row.state==='paid'?`Проведение платежа ${(body.payment.amountCents/100).toFixed(2)} ₽ подтверждено журналом.`:row.state==='payment_pending'?'Результат платежа еще проверяется. Повторная отправка не требуется.':'Проведение платежа еще не подтверждено журналом.',
   `https://example.invalid/crm/type/1078/details/${selected.id}/`];
  if(/сделк|успех/iu.test(context.text)&&Number.isSafeInteger(invoice.parentId2)&&invoice.parentId2>0){
   try{
    const deal=(await vibe.request('/deals/'+invoice.parentId2)).data,stage=deal?.stageId??deal?.STAGE_ID;
    if(!stage)throw Error('NO_STAGE');
    lines.push(`Связанная сделка ${invoice.parentId2}: ${/(?:^|:)WON$/.test(stage)?'уже в стадии «Успех»':`текущая стадия ${safe(stage)}`}.`,
     `https://example.invalid/crm/deal/details/${invoice.parentId2}/`);
   }catch{lines.push('Текущую стадию связанной сделки сейчас проверить не удалось.');}
  }
  if(job.reason==='TEAM_CONVERSATION')lines.unshift('Ваш вопрос был ошибочно пропущен фильтром бота. Ошибка исправлена; проверил актуальный статус.');
  reply(lines.join('\n'));
 }catch{reply('Не удалось прочитать текущий статус счета в CRM. Повторите вопрос позже; этот запрос не запускает оплату.');}
}
