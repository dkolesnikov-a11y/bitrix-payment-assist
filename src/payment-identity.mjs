import {createHash} from 'node:crypto';

export function paymentDate(value){
 const text=String(value??'').trim().toLowerCase().replace(/\s+/gu,' ');
 const months=['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
 let y,m,d,parts;
 if((parts=text.match(/^(\d{4})-(\d{2})-(\d{2})$/)))[,y,m,d]=parts;
 else if((parts=text.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/)))[,d,m,y]=parts;
 else if((parts=text.match(/^(\d{1,2}) ([а-я]+) (\d{4})$/))){d=parts[1];m=months.indexOf(parts[2])+1;y=parts[3];}
 else return null;
 const iso=`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
 const dt=new Date(iso+'T00:00:00Z');
 return Number.isFinite(dt.getTime())&&dt.toISOString().slice(0,10)===iso?iso:null;
}

export function bankReference(value){
 return String(value??'').trim().replace(/^№\s*/u,'').normalize('NFKC').toUpperCase().replace(/\s+/gu,'');
}

// Include both legal entities: equal invoice numbers alone never identify a payment.
export function paymentIdentity(payment,selected){
 const date=paymentDate(payment?.date),reference=bankReference(payment?.bankReference);
 if(!reference)return paymentFallbackIdentity(payment,selected);
 if(!date||!selected?.companyId||!selected?.mycompanyId||!Number.isSafeInteger(payment?.amountCents)||payment.amountCents<=0||!payment.currency)return null;
 return createHash('sha256').update(JSON.stringify([selected.companyId,selected.mycompanyId,reference,date,payment.amountCents,payment.currency])).digest('hex');
}

// Without a bank reference, conservatively reserve the invoice/date/amount combination.
// This is a local identity, never a fabricated bank reference. A second equal payment
// on the same date requires reconciliation instead of another automatic write.
export function paymentFallbackIdentity(payment,selected){
 const date=paymentDate(payment?.date),invoice=selected?.id??selected?.invoiceId;
 if(!date||!invoice||!selected?.companyId||!selected?.mycompanyId||!Number.isSafeInteger(payment?.amountCents)||payment.amountCents<=0||!payment.currency)return null;
 return createHash('sha256').update(JSON.stringify(['invoice-date-amount-v1',invoice,selected.companyId,selected.mycompanyId,date,payment.amountCents,payment.currency])).digest('hex');
}
export function samePayment(a,selectedA,b,selectedB){
 const primary=paymentIdentity(a,selectedA);
 if(primary&&primary===paymentIdentity(b,selectedB))return true;
 if(bankReference(a?.bankReference)&&bankReference(b?.bankReference))return false;
 const fallback=paymentFallbackIdentity(a,selectedA);
 return !!fallback&&fallback===paymentFallbackIdentity(b,selectedB);
}
