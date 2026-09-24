import {readFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
export async function config(path) {
  const file=resolve(path),c=JSON.parse(await readFile(file,'utf8'));
  const positive=x=>Number.isSafeInteger(x)&&x>0;
  c.adminUsers??=[49];
  c.uploadUsers??=[49];
  if(c.automatic?.allowPartialPayments!==undefined&&typeof c.automatic.allowPartialPayments!=='boolean')throw Error('INVALID_PARTIAL_AUTO_POLICY');
  if(c.automatic?.allowExactScreenshotPayments!==undefined&&typeof c.automatic.allowExactScreenshotPayments!=='boolean')throw Error('INVALID_SCREENSHOT_AUTO_POLICY');
  if(c.paymentDatePolicy!==undefined&&!['visible_only','message_when_missing'].includes(c.paymentDatePolicy))throw Error('INVALID_PAYMENT_DATE_POLICY');
  if(!Array.isArray(c.uploadUsers)||!c.uploadUsers.length||!c.uploadUsers.every(positive))throw Error('UPLOAD_USERS_REQUIRED');
  if(c.teamDialog!==undefined&&!/^chat[1-9]\d*$/.test(c.teamDialog))throw Error('INVALID_TEAM_DIALOG');
  if(c.teamDialog&&!c.allowedDialogs.includes(c.teamDialog))throw Error('TEAM_DIALOG_NOT_ALLOWED');
  c.recipientCompanyIds??=[2281,2285];
  if(!Array.isArray(c.adminUsers)||!c.adminUsers.length||!c.adminUsers.every(positive))throw Error('ADMINS_REQUIRED');
  if(!Array.isArray(c.recipientCompanyIds)||!c.recipientCompanyIds.length||!c.recipientCompanyIds.every(x=>[2281,2285].includes(x)))throw Error('RECIPIENT_SCOPE_REQUIRED');
  if(c.portal!=='example.invalid')throw Error('PORTAL_NOT_CONFIGURED');
  if(!Array.isArray(c.allowedUsers)||!c.allowedUsers.length||!c.allowedUsers.every(positive))throw Error('USERS_REQUIRED');
  if(!Array.isArray(c.allowedDialogs)||!c.allowedDialogs.length||!c.allowedDialogs.every(x=>typeof x==='string'&&/^(?:chat)?\d+$/.test(x)))throw Error('DIALOGS_REQUIRED');
  if(!Number.isSafeInteger(c.botId)||c.botId<0)throw Error('INVALID_BOT');
  if(typeof c.crmWrites!=='boolean'||typeof c.sendMessages!=='boolean')throw Error('WRITE_FLAGS_REQUIRED');
  if(!Array.isArray(c.invoiceAllowlist)||!c.invoiceAllowlist.every(positive))throw Error('INVOICE_ALLOWLIST_REQUIRED');
  if(c.crmWrites&&!c.invoiceAllowlist.length)throw Error('WRITE_ALLOWLIST_EMPTY');
  if(!positive(c.pollIntervalMs)||c.pollIntervalMs<2000||c.pollIntervalMs>60000)throw Error('INVALID_POLL_INTERVAL');
  if(!positive(c.maxFileBytes)||c.maxFileBytes>20*1024*1024)throw Error('INVALID_FILE_LIMIT');
  if(!Array.isArray(c.downloadHosts)||!c.downloadHosts.length||!c.downloadHosts.every(x=>typeof x==='string'&&/^[a-z0-9.-]+$/.test(x)))throw Error('DOWNLOAD_HOSTS_REQUIRED');
  if(c.ocr?.url){const url=new URL(c.ocr.url);if(url.protocol!=='https:'||url.username||url.password)throw Error('INVALID_OCR_URL');}
  if(c.ocr?.provider&&!['gateway','vibe'].includes(c.ocr.provider))throw Error('INVALID_OCR_PROVIDER');
  if(c.automatic?.enabled&&(!Number.isSafeInteger(c.automatic.fromEventId)||c.automatic.fromEventId<1||!/^\d{4}-\d{2}-\d{2}$/.test(c.automatic.fromDate??'')))throw Error('INVALID_AUTO_POLICY');
  if(c.automatic?.scope!==undefined&&!['allowlist','recipient_companies'].includes(c.automatic.scope))throw Error('INVALID_AUTO_SCOPE');
  return {...c,keyFile:resolve(dirname(file),c.keyFile),dataDir:resolve(dirname(file),c.dataDir),
    ocr:{provider:c.ocr?.provider??'gateway',url:c.ocr?.url??'',keyFile:c.ocr?.keyFile?resolve(dirname(file),c.ocr.keyFile):''}};
}
