import {automaticInvoiceAllowed} from './payment-scope.mjs';
import {cents} from '../tools/payment-safety/guard.mjs';
import {invoiceReferences} from './invoice-references.mjs';
const active=new Set(['DT1078_31:PREPARATION','DT1078_31:CLIENT','DT1078_31:UC_WEUS73']);
export function legalName(value){
 return String(value??'').normalize('NFKC').toUpperCase().replace(/Ё/g,'Е')
 .replace(/\(?\s*ИНН\s*\d{10,12}\s*\)?/g,' ')
 .replace(/ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ/g,'ООО')
 .replace(/ЗАКРЫТОЕ АКЦИОНЕРНОЕ ОБЩЕСТВО/g,'ЗАО').replace(/ОТКРЫТОЕ АКЦИОНЕРНОЕ ОБЩЕСТВО/g,'ОАО')
 .replace(/ПУБЛИЧНОЕ АКЦИОНЕРНОЕ ОБЩЕСТВО/g,'ПАО').replace(/АКЦИОНЕРНОЕ ОБЩЕСТВО/g,'АО')
 .replace(/ИНДИВИДУАЛЬНЫЙ ПРЕДПРИНИМАТЕЛЬ/g,'ИП').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
}
const core=value=>legalName(value).replace(/^(?:ООО|ЗАО|ОАО|ПАО|АО|ИП)\s+/,'');
const num=value=>String(value??'').normalize('NFKC').toUpperCase().replace(/[\s№]/g,'').replace(/[–—]/g,'-');
const numberReason=c=>'Совпадают юрлицо и номер счета из назначения. '+{exact:'Сумма совпадает с остатком.',partial:'Частичная оплата.',overpayment:'Сумма платежа превышает остаток; проведение требует сверки.',unknown:'Остаток требует проверки перед проведением.'}[c.amountMatch];
export function matchPayment(payment,items){
 const name=legalName(payment.payerName),base=core(payment.payerName),refs=invoiceReferences(payment.purpose);
 if(payment.currency!=='RUB'||payment.direction==='outgoing'||payment.status==='pending')return {status:'needs_data',candidates:[],reason:'Не подтвержден входящий рублевый платеж. Требуется проверка.'};
 if(!base||!Number.isSafeInteger(payment.amountCents)||payment.amountCents<=0)return {status:'needs_data',candidates:[],reason:'Не определены плательщик или сумма.'};
 const candidates=[];
 for(const item of items){
  if(item.categoryId!==31||!active.has(item.stageId)||item.currencyId!=='RUB')continue;
  const party=item.ufCrm23_1768411333||item.companyTitle;
  if(!party||core(party)!==base)continue;
  const visibleInn=String(party).match(/ИНН\s*(\d{10,12})/iu)?.[1];
  if(payment.payerInn&&visibleInn&&payment.payerInn!==visibleInn)continue;
  let balance;try{balance=cents(item.ufCrm23_1770923673);}catch{balance=null;}
  if(balance===0)continue;
  const number=String(item.ufCrm23_1768411703??'');
  const numbers=number.split(/[,;\r\n]+/u).map(num).filter(Boolean);
  const exactNumber=refs.some(r=>numbers.includes(num(r.number)));
  const suffixNumber=!exactNumber&&numbers.some(n=>/^\d+$/.test(n)&&refs.some(r=>num(r.number).endsWith('-'+n)));
  candidates.push({id:item.id,stageId:item.stageId,companyId:item.companyId,mycompanyId:item.mycompanyId,title:item.title,legalName:party,number,balanceCents:balance,
   nameExact:legalName(party)===name,numberMatch:exactNumber?'exact':suffixNumber?'suffix':refs.length?'different':'unknown',
   amountMatch:balance===null?'unknown':balance===payment.amountCents?'exact':balance>payment.amountCents?'partial':'overpayment',
   recipientConfirmed:false});
 }
 const rank=c=>(c.amountMatch==='exact'?100:0)+(c.numberMatch==='exact'?40:c.numberMatch==='suffix'?15:0)+(c.nameExact?5:0);
 candidates.sort((a,b)=>rank(b)-rank(a)||a.id-b.id);
 const numbered=candidates.filter(c=>c.numberMatch==='exact'||c.numberMatch==='suffix');
 const referenceNumbers=new Set(refs.map(r=>num(r.number)));
 if(referenceNumbers.size===1&&numbered.length===1&&numbered[0].nameExact){
  const selected=numbered[0];
  return {status:'candidate',decisive:true,candidates:[selected],excludedCandidates:candidates.filter(c=>c.id!==selected.id),reviewOnly:true,reason:numberReason(selected)};
 }
 return {status:candidates.length===0?'not_found':candidates.length===1?'candidate':'ambiguous',candidates,
  reviewOnly:true,reason:'Предложение для проверки: получатель и выбор счета требуют подтверждения. Записи в CRM нет.'};
}
export async function loadInvoices(vibe){
 const rows=[],seen=new Set();let after=0;
 for(let page=0;page<20;page++){
  const q=new URLSearchParams({'filter[categoryId]':'31','filter[>id]':String(after),'order[id]':'asc',limit:'500',select:'id,title,stageId,categoryId,companyId,mycompanyId,currencyId,ufCrm23_1768411333,ufCrm23_1768411703,ufCrm23_1770923673'});
  const r=await vibe.request('/items/1078?'+q);
  if(!Array.isArray(r.data)||typeof r.meta?.hasMore!=='boolean')throw Error('MATCHING_PAGE_INVALID');
  for(const row of r.data){if(!Number.isSafeInteger(row.id)||row.id<=after||seen.has(row.id))throw Error('MATCHING_PAGE_INVALID');seen.add(row.id);rows.push(row);}
  if(!r.meta.hasMore){
   const missing=[...new Set(rows.filter(x=>active.has(x.stageId)&&!x.ufCrm23_1768411333&&x.companyId).map(x=>x.companyId))];
   if(missing.length>200)throw Error('MATCHING_COMPANY_LIMIT');
   for(const id of missing){const company=(await vibe.request('/companies/'+id)).data;for(const row of rows)if(row.companyId===id)row.companyTitle=company.title;}
   return rows;
  }
  const next=Number(r.meta.nextAfterId);if(!Number.isSafeInteger(next)||next<=after)throw Error('MATCHING_CURSOR_INVALID');after=next;
 }
 throw Error('MATCHING_LIMIT');
}
const safe=v=>String(v??'не указано').replace(/[\[\]<>\r\n]/g,' ').slice(0,160);
export function formatMatches(results,config={}){
 const lines=['Подбор по названию юрлица и сумме (предварительно):'];
 for(const [i,r] of results.entries()){
  lines.push(`Платеж ${i+1}:`);
  if(!r.candidates.length){lines.push(r.reason??'Активные счета с таким названием юрлица не найдены.');continue;}
  if(r.decisive){
   const c=r.candidates[0];lines.push(`Счет № ${safe(c.number)} однозначно найден: ${safe(c.legalName)}. Остаток: ${c.balanceCents===null?'не определен':(c.balanceCents/100).toFixed(2)+' ₽'}. ${numberReason(c)}\nhttps://example.invalid/crm/type/1078/details/${c.id}/`);
   lines.push(r.review?.text??(config.crmWrites&&automaticInvoiceAllowed(config,c)?'Автопроведение не выполнено: требуется проверка остальных данных платежа. Выберите счет кнопкой для проверки.':'Оплата не проведена: запись для этого счета сейчас выключена.'));continue;
  }
  for(const c of r.candidates.slice(0,5))lines.push(`• Счет ${safe(c.number)} (ID ${c.id}), ${safe(c.legalName)}. Остаток: ${c.balanceCents===null?'не определен':(c.balanceCents/100).toFixed(2)+' ₽'}. ${ {exact:'Сумма совпадает.',partial:'Возможна частичная оплата.',overpayment:'Сумма превышает остаток.',unknown:'Остаток требует проверки.'}[c.amountMatch]} Номер: ${{exact:'совпадает',suffix:'совпадает числовая часть, префикс требует проверки',different:'не совпадает с назначением',unknown:'нет в назначении'}[c.numberMatch]}.
https://example.invalid/crm/type/1078/details/${c.id}/`);
  if(r.candidates.length>5)lines.push(`Всего подходящих по названию: ${r.candidates.length}; показаны первые 5.`);
  lines.push(r.review?.text??(r.candidates.length>1?'Какой из счетов относится к платежу и кому поступили деньги?':'Проверьте найденный счет и получателя платежа.'));
 }
 if(results.some(r=>!r.decisive))lines.push('Подбор сам по себе не проводит оплату.');return lines.join('\n');
}
