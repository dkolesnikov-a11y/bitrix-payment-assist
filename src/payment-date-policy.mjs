// User-selected accounting date, separate from what OCR can see.
export function applyPaymentDatePolicy(payment,event,config){
 if(config.paymentDatePolicy!=='message_when_missing'||payment.date)return payment;
 const timestamp=event.date;
 if(typeof timestamp!=='string'||!/(?:Z|[+-]\d{2}:\d{2})$/.test(timestamp))return payment;
 const instant=new Date(timestamp);if(!Number.isFinite(instant.getTime()))return payment;
 const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(instant);
 return {...payment,date,dateSource:{kind:'screenshot_message_date',eventId:String(event.eventId),timezone:'Europe/Moscow',policy:'message_when_missing'}};
}
