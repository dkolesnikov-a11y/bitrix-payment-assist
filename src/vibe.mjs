import {readFile} from 'node:fs/promises';
import {cents} from '../tools/payment-safety/guard.mjs';
const positive=x=>Number.isSafeInteger(x)&&x>0;
export class Vibe {
  constructor(config,key,fetcher=fetch){this.config=config;this.key=key;this.fetch=fetcher;this.actorId=null;
    // Exported payment BP: CrmTimelineCommentAdd.Author = Document:ASSIGNED_BY_ID.
    this.paymentCommentAuthorField='assignedById';
  }
  static async create(config){
    const key=(await readFile(config.keyFile,'utf8')).replace(/^\uFEFF/,'').trim();
    if(!/^vibe_api_\S+$/.test(key))throw Error('INVALID_VIBE_KEY');
    return new Vibe(config,key);
  }
  async request(path,method='GET',body){
    if(!path.startsWith('/')||path.includes('..'))throw Error('INVALID_API_PATH');
    // Bitrix can acknowledge bare command-button arrays while silently dropping
    // them. Explicitly bind both initial and updated keyboards to their bot.
    if(body&&/^\/bots\/\d+\/(?:messages(?:\/\d+)?|commands\/\d+\/answer)$/.test(path)){
      const botId=Number(path.split('/')[2]);
      const wrap=keyboard=>Array.isArray(keyboard)?{BOT_ID:botId,BUTTONS:keyboard}:keyboard;
      body={...body,...(body.keyboard!==undefined?{keyboard:wrap(body.keyboard)}:{}),
        ...(body.fields?{fields:{...body.fields,...(body.fields.keyboard!==undefined?{keyboard:wrap(body.fields.keyboard)}:{})}}:{})};
    }
    let response;
    try{response=await this.fetch('https://vibecode.bitrix24.tech/v1'+path,{
      method,headers:{'X-Api-Key':this.key,'Content-Type':'application/json'},
      body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(45000)
    });}catch{throw Error('API_TRANSPORT_UNKNOWN');}
    let envelope;try{envelope=await response.json();}catch{throw Error('API_RESPONSE_UNKNOWN');}
    if(!response.ok||envelope.success!==true)throw Error(`API_HTTP_${response.status}`);
    return envelope;
  }
  async verify(){
    const result=await this.request('/me');
    const d=result.data;
    if(d?.portal!==this.config.portal)throw Error('KEY_PORTAL_MISMATCH');
    const user=await this.request('/users/me');
    if(!positive(Number(user.data.id)))throw Error('API_USER_UNKNOWN');
    this.actorId=String(user.data.id);return {actorId:this.actorId};
  }
  async events(offset){
    if(!positive(this.config.botId)||!Number.isSafeInteger(offset)||offset<0)throw Error('BOT_NOT_CONFIGURED');
    return (await this.request(`/bots/${this.config.botId}/events?offset=${offset}&limit=100`)).data;
  }
  async read(id){if(!positive(id))throw Error('INVALID_INVOICE');return (await this.request('/items/1078/'+id)).data;}
  async apply(id,fields){
    if(!this.config.crmWrites||(!this.config.invoiceAllowlist.includes(id)&&!(this.config.automatic?.enabled&&this.config.automatic?.scope==='recipient_companies')))throw Error('CRM_WRITES_DISABLED');
    if(!this.actorId)throw Error('API_NOT_VERIFIED');
    if(this.config.automatic?.scope==='recipient_companies'&&!this.config.recipientCompanyIds?.length)throw Error('RECIPIENT_NOT_ALLOWED');
    if(this.config.recipientCompanyIds){const invoice=await this.read(id);if(invoice.categoryId!==31||!this.config.recipientCompanyIds.includes(Number(invoice.mycompanyId)))throw Error('RECIPIENT_NOT_ALLOWED');}
    const keys=Object.keys(fields).sort();
    if(JSON.stringify(keys)!==JSON.stringify(['stageId','ufCrm23_1770921060'])||fields.stageId!=='DT1078_31:SUCCESS'||cents(fields.ufCrm23_1770921060)<=0)throw Error('INVALID_PAYMENT_FIELDS');
    await this.request('/items/1078/'+id,'PATCH',fields);
    return {accepted:true,actorId:this.actorId};
  }
  async readComments(id){
    if(!positive(id))throw Error('INVALID_INVOICE');
    const result=[];
    for(let offset=0;offset<5000;offset+=100){
      const page=await this.request(`/timelines?filter[entityType]=DYNAMIC_1078&filter[entityId]=${id}&limit=100&offset=${offset}`);
      if(!Array.isArray(page.data))throw Error('INVALID_COMMENTS');
      for(const row of page.data){
        const match=/^Внесена сумма по счету: (\d+(?:\.\d{1,2})?\|RUB)(?:\r?\n|$)/.exec(row.comment??'');
        result.push({id:String(row.id),actorId:String(row.authorId),amountCents:match?cents(match[1]):null});
      }
      if(page.meta?.hasMore===false)return result;
      if(page.data.length===0)throw Error('COMMENTS_PAGINATION_UNKNOWN');
    }
    throw Error('COMMENTS_LIMIT_REACHED');
  }
  async uploadImage(dialogId,text,image){
    if(!this.config.sendMessages||dialogId!==this.config.teamDialog||!this.config.allowedDialogs.includes(dialogId))throw Error('MESSAGES_DISABLED');
    if(!['image/png','image/jpeg'].includes(image.mime)||!Buffer.isBuffer(image.bytes)||!image.bytes.length||image.bytes.length>this.config.maxFileBytes)throw Error('INVALID_IMAGE');
    const r=await this.request(`/bots/${this.config.botId}/files`,'POST',{dialogId,file:{name:image.name,content:image.bytes.toString('base64')},message:text});
    if(!positive(Number(r.data?.messageId)))throw Error('UPLOAD_RESULT_UNKNOWN');
    return String(r.data.messageId);
  }
  async send(dialogId,text,keyboard,forwardIds){
    if(!this.config.sendMessages||!this.config.allowedDialogs.includes(dialogId))throw Error('MESSAGES_DISABLED');
    if(forwardIds&&(!Object.keys(forwardIds).length||Object.keys(forwardIds).length>100||!Object.values(forwardIds).every(positive)))throw Error('INVALID_FORWARD_IDS');
    const r=await this.request(`/bots/${this.config.botId}/messages`,'POST',{dialogId,fields:{message:text,...(keyboard?{keyboard}:{}),...(forwardIds?{forwardIds}:{})}});
    return String(r.data.id);
  }
  async answerCommand(dialogId,text,command,keyboard){
    if(!this.config.sendMessages||!this.config.allowedDialogs.includes(dialogId))throw Error('MESSAGES_DISABLED');
    if(!positive(command.commandId)||!positive(command.messageId))throw Error('INVALID_COMMAND');
    const r=await this.request(`/bots/${this.config.botId}/commands/${command.commandId}/answer`,'POST',{dialogId,messageId:command.messageId,fields:{message:text,...(keyboard?{keyboard}:{})}});
    return String(r.data?.id??r.data?.messageId??'command-answered');
  }
  async download(fileId){
    if(!positive(fileId))throw Error('INVALID_FILE');
    const meta=(await this.request(`/bots/${this.config.botId}/files/${fileId}`)).data;
    // This endpoint may return only downloadUrl; enforce the byte limit while streaming too.
    if(meta.size!==undefined&&(!Number.isSafeInteger(meta.size)||meta.size<1||meta.size>this.config.maxFileBytes))throw Error('FILE_TOO_LARGE');
    const url=new URL(meta.downloadUrl);
    if(url.protocol!=='https:'||url.username||url.password||!this.config.downloadHosts.includes(url.hostname))throw Error('DOWNLOAD_HOST_NOT_ALLOWED');
    // Never attach the VibeCode key to a portal/storage download URL.
    const r=await this.fetch(url,{redirect:'error',signal:AbortSignal.timeout(30000)});
    if(!r.ok||!r.body)throw Error('DOWNLOAD_FAILED');
    const chunks=[];let total=0;
    for await(const chunk of r.body){total+=chunk.length;if(total>this.config.maxFileBytes){await r.body.cancel().catch(()=>{});throw Error('FILE_TOO_LARGE');}chunks.push(chunk);}
    const bytes=Buffer.concat(chunks);
    const png=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    const jpeg=bytes.length>3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
    if(!png&&!jpeg)throw Error('ONLY_PNG_JPEG');
    return {bytes,mime:png?'image/png':'image/jpeg'};
  }
}
