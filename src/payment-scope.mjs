export function automaticInvoiceAllowed(config,invoice){
 return config.invoiceAllowlist?.includes(invoice.id)||config.automatic?.scope==='recipient_companies'&&config.recipientCompanyIds?.includes(Number(invoice.mycompanyId));
}
import {paymentStartStages} from '../tools/payment-safety/guard.mjs';
import {bankReference} from './payment-identity.mjs';
export function automaticPartialAllowed(payment,selected,policy,eventId){
 return policy?.enabled===true&&policy.allowPartialPayments===true&&Number(eventId)>=policy.fromEventId
  &&selected?.nameExact===true&&selected.amountMatch==='partial'&&['exact','suffix'].includes(selected.numberMatch)
  &&paymentStartStages.has(selected.stageId)&&Number.isSafeInteger(selected.balanceCents)
  &&Number.isSafeInteger(payment.amountCents)&&payment.amountCents>0&&payment.amountCents<selected.balanceCents
  &&payment.currency==='RUB'&&payment.direction==='incoming'&&payment.status==='credited'
  &&!!(bankReference(payment.bankReference)||policy.allowExactScreenshotPayments===true);
}
