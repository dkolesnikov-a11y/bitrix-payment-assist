import {createHash} from 'node:crypto';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {Journal,PaymentGuard} from '../tools/payment-safety/guard.mjs';
import {Recovery} from '../tools/payment-safety/recovery.mjs';
import {formatDraft} from './vibe-ocr.mjs';
import {loadInvoices,matchPayment,formatMatches} from './matching.mjs';
import {handleReply,prepareChoiceButtons} from './dialog.mjs';
import {processPayments} from './payments.mjs';
import {prepareAutomatic} from './automatic.mjs';
import {Access} from './access.mjs';
import {isTeam,teamAuthorized} from './team.mjs';
import {answerQuestion,isPaymentQuestion} from './questions.mjs';
import {applyPaymentDatePolicy} from './payment-date-policy.mjs';
export class Service{
  constructor(config,store,vibe,ocr){
    this.config=config;this.store=store;this.vibe=vibe;this.ocr=ocr;
    this.access=new Access(config,store);
    this.journal=new Journal(join(config.dataDir,'payments.sqlite'));
    this.guard=new PaymentGuard(this.journal,vibe);
    this.recovery=new Recovery(this.guard,{allowedOperators:(config.adminUsers??config.allowedUsers).map(String)});
  }
  accept(event){
    const d=event.data,m=d?.message;
    const isCommand=event.type==='ONIMBOTV2COMMANDADD';
    if(!['ONIMBOTV2MESSAGEADD','ONIMBOTV2COMMANDADD'].includes(event.type)||!m||m.isSystem||(!isCommand&&m.authorId===this.config.botId))return null;
    const author=isCommand?d.user?.id:m.authorId;
    // Keyboard events refer to the bot's original message. Recover its original
    // destination from our sent outbox when Bitrix omits dialogId.
    const sent=isCommand?this.store.db.prepare("SELECT dialog FROM outbox WHERE remote_id=? AND state='sent'").get(String(m.id)):null;
    const dialog=d.chat?.dialogId??d.dialogId??sent?.dialog;
    if(sent&&dialog!==sent.dialog)return null;
    if(d.chat?.dialogId!==undefined&&d.dialogId!==undefined&&d.chat.dialogId!==d.dialogId)return null;
    if(d.bot?.id!==this.config.botId||!Number.isSafeInteger(author)||!this.config.allowedDialogs.includes(dialog))return null;
    if(!isTeam(this.config,dialog)&&(!this.config.allowedUsers.includes(author)||!this.access.accepts(author,dialog,event.eventId)))return null;
    if(!Number.isSafeInteger(m.id)||m.id<=0)return null;
    if(isCommand){
      const c=d.command,label={payment_invoice_select:'Выбрать счет',payment_choice_confirm:'Подтвердить выбор',payment_choice_reject:'Отклонить выбор'}[c?.command?.replace(/^\//,'')];
      if(!label||c.context!=='keyboard'||!Number.isSafeInteger(c.id)||c.id<=0||!/^\w{8}-[a-f0-9-]{27}$/.test(c.params??''))return null;
      return {dialog,author,text:label+' '+c.params,files:[],commandReply:{commandId:c.id,messageId:m.id}};
    }
    const files=m.params?.FILE_ID??[];
    if(!Array.isArray(files)||files.length>20||!files.every(x=>/^\d+$/.test(String(x))&&Number.isSafeInteger(Number(x))&&Number(x)>0))throw Error('INVALID_ATTACHMENTS');
    const text=(typeof m.text==='string'?m.text:'').replace(new RegExp(`\\[USER=${this.config.botId}\\][\\s\\S]*?\\[/USER\\]`,'gi'),'').trim();
    return {dialog,author:m.authorId,text,files:[...new Set(files.map(Number))],addressed:String(m.text??'').toUpperCase().includes(`[USER=${this.config.botId}]`),replyTo:m.params?.REPLY_ID??null};
  }
  async poll(){const page=await this.vibe.events(this.store.cursor());this.store.ingest(page);return page;}
  async process(){
    for(const job of this.store.pending()){
      let context;
      try{context=this.accept(JSON.parse(job.body));}catch{this.store.finish(job.id,'review','INVALID_ATTACHMENTS');continue;}
      if(!context){this.store.finish(job.id,'ignored','NOT_AUTHORIZED_OR_NOT_MESSAGE');continue;}
      if(context.files.length&&this.config.teamDialog&&this.config.uploadUsers.includes(context.author)&&context.dialog===String(context.author)){
        try{if(!await teamAuthorized(this.vibe,this.config,context.author)){this.store.finish(job.id,'review','UPLOADER_NOT_TEAM_MEMBER',{dialog:context.dialog,text:'Вы больше не участник общего чата оплат. Скриншот не передан и оплата не проводилась.'});continue;}}catch{break;}
        this.store.tx(()=>{
          this.store.db.prepare('INSERT OR IGNORE INTO image_routes VALUES(?,?,?)').run(job.id,context.dialog,this.config.teamDialog);
          this.store.db.prepare('INSERT OR IGNORE INTO outbox(id,event_id,dialog,text) VALUES(?,?,?,?)').run('receipt:'+job.id,job.id,context.dialog,'Скриншот принят. Разбор и результаты оплаты появятся в общем чате «Оплаты — разбор счетов».');
        });
        context={...context,dialog:this.store.db.prepare('SELECT target_dialog FROM image_routes WHERE event_id=?').get(job.id).target_dialog};
      }
      if(isTeam(this.config,context.dialog)){
        try{if(!await teamAuthorized(this.vibe,this.config,context.author)){this.store.finish(job.id,'ignored','NOT_TEAM_MEMBER');continue;}}
        catch{break;} // Keep the event pending until current membership can be verified.
        if(context.files.length&&!this.config.uploadUsers.includes(context.author)){
          this.store.finish(job.id,'ignored','UPLOAD_NOT_ALLOWED',{dialog:context.dialog,text:'Скриншоты для учета отправляет Дмитрий. Участники чата могут выбирать счета и подтверждать спорные платежи.'});continue;
        }
        if(!context.files.length&&!context.addressed&&!/^(?:\/?доступ\b|доступ(?:\s|$)|сч[её]т|счте|\d|Выбрать счет|Подтвердить выбор|Отклонить выбор|да[.!]?$|верно[.!]?$|подтверждаю[.!]?$)/iu.test(context.text.trim())){
          this.store.finish(job.id,'ignored','TEAM_CONVERSATION');continue;
        }
      }
      if(!context.files.length){
        if(!context.commandReply&&isPaymentQuestion(context.text)){
          await answerQuestion(this.store,this.vibe,job,context);continue;
        }
        try{if(!await this.access.handle(this.vibe,job,context))await handleReply(this.store,this.vibe,job,context,this.config);}
        catch{this.store.finish(job.id,'review','DIALOG_READ_FAILED',{dialog:context.dialog,text:'Не удалось проверить счет в CRM. Выбор не изменен, оплата не проводилась. Повторите ответ немного позже.'});}
        continue;
      }
      try{
        for(const fileId of context.files){
          if(this.store.db.prepare('SELECT 1 FROM extracted WHERE event_id=? AND file_id=?').get(job.id,fileId))continue;
          const image=await this.vibe.download(fileId),hash=createHash('sha256').update(image.bytes).digest('hex');
          const dir=join(this.config.dataDir,'images');await mkdir(dir,{recursive:true});const path=join(dir,hash);
          await writeFile(path,image.bytes,{flag:'wx'}).catch(e=>{if(e.code!=='EEXIST')throw e;});
          this.store.db.prepare('INSERT OR IGNORE INTO artifacts(event_id,file_id,hash,mime,path) VALUES(?,?,?,?,?)').run(job.id,fileId,hash,image.mime,path);
          if(this.store.db.prepare('SELECT 1 FROM image_routes WHERE event_id=?').get(job.id))this.store.db.prepare('INSERT OR IGNORE INTO outbox(id,event_id,dialog,text,image_file_id) VALUES(?,?,?,?,?)').run(`image:${job.id}:${fileId}`,job.id,context.dialog,'Скриншот платежа от Дмитрия.',fileId);
          const result=await this.ocr.extract(image);
          result.payments=result.payments.map(payment=>applyPaymentDatePolicy(payment,JSON.parse(job.body),this.config));
          this.store.db.prepare('INSERT OR IGNORE INTO extracted(event_id,file_id,body) VALUES(?,?,?)').run(job.id,fileId,JSON.stringify(result));
        }
        // Until matching/organization/overpayment rules are completed, extraction is a proposal only.
        const results=this.store.db.prepare('SELECT body FROM extracted WHERE event_id=? ORDER BY file_id').all(job.id).map(r=>JSON.parse(r.body));
        if(typeof this.vibe.request!=='function'){
          this.store.finish(job.id,'review','MATCHING_NOT_CONNECTED',{dialog:context.dialog,text:formatDraft(results)});
        }else{
          let text,reason,keyboard;
          try{
            const invoices=(await loadInvoices(this.vibe)).filter(x=>!this.config.recipientCompanyIds||this.config.recipientCompanyIds.includes(Number(x.mycompanyId))),matches=results.flatMap(x=>x.payments.map(p=>matchPayment(p,invoices)));
            const auto=await prepareAutomatic(this,job,context,results.flatMap(x=>x.payments),matches);
            this.store.db.prepare('INSERT OR REPLACE INTO matches(event_id,body) VALUES(?,?)').run(job.id,JSON.stringify({at:new Date().toISOString(),matches}));
            if(!auto)keyboard=prepareChoiceButtons(this.store,job,context,results.flatMap(x=>x.payments),matches);
            const draft=formatDraft(results,false);
            text=auto?'Счет однозначно найден. Проверяю проведение оплаты; результат сообщу отдельно.':(matches.every(m=>m.decisive)?draft.replace('Распознано предварительно — требуется проверка:','Платеж распознан:'):draft)+'\n\n'+formatMatches(matches,this.config);reason=auto?'AUTO_PAYMENT_QUEUED':'MATCHING_REVIEW';
          }catch{text=formatDraft(results,false)+'\n\nНе удалось завершить поиск счетов в CRM. Оплата не проводилась.';reason='MATCHING_UNAVAILABLE';}
          this.store.finish(job.id,'review',reason,{dialog:context.dialog,text,keyboard});
        }
      }catch(error){
        const reason=error.message==='OCR_NOT_CONFIGURED'?'OCR_NOT_CONFIGURED':'IMAGE_REVIEW_REQUIRED';
        const text=reason==='OCR_NOT_CONFIGURED'?'Скриншот получен. Распознавание еще не подключено, поэтому оплата не проводилась.':'Не удалось надежно обработать скриншот. Оплата не проводилась; изображение требует проверки.';
        this.store.finish(job.id,'review',reason,{dialog:context.dialog,text});
      }
    }
  }
  async deliver(){
    if(!this.config.sendMessages)return;
    for(let i=0;i<50;i++){
      const row=this.store.claimReply();if(!row)return;
      if(row.image_file_id){
        try{
          const artifact=this.store.db.prepare('SELECT * FROM artifacts WHERE event_id=? AND file_id=?').get(row.event_id,row.image_file_id);
          if(!artifact)throw Error('IMAGE_NOT_FOUND');
          const bytes=await readFile(artifact.path);
          if(createHash('sha256').update(bytes).digest('hex')!==artifact.hash)throw Error('IMAGE_HASH_MISMATCH');
          const id=await this.vibe.uploadImage(row.dialog,row.text,{bytes,mime:artifact.mime,name:`payment-${row.event_id}-${row.image_file_id}.${artifact.mime==='image/png'?'png':'jpg'}`});
          this.store.db.prepare("UPDATE outbox SET state='sent',remote_id=? WHERE id=?").run(id,row.id);
        }catch{this.store.db.prepare("UPDATE outbox SET state='uncertain' WHERE id=?").run(row.id);}
        continue;
      }
      try{const keyboard=row.keyboard?JSON.parse(row.keyboard):undefined;const id=row.command_reply?await this.vibe.answerCommand(row.dialog,row.text,JSON.parse(row.command_reply),keyboard):await this.vibe.send(row.dialog,row.text,keyboard,row.forward_ids?JSON.parse(row.forward_ids):undefined);this.store.db.prepare("UPDATE outbox SET state='sent',remote_id=? WHERE id=?").run(id,row.id);}
      catch{this.store.db.prepare("UPDATE outbox SET state='uncertain' WHERE id=?").run(row.id);}
      // No blind retry of a possibly delivered message; resolve by chat history later.
    }
  }
  async processPayments(){await processPayments(this);}
  async cycle(){const page=await this.poll();await this.process();await this.recovery.recover();await this.processPayments();await this.deliver();return page;}
  async submitPayment(spec){
    if(!this.config.crmWrites)return {status:'dry_run',invoiceId:spec.invoiceId,amountCents:spec.amountCents};
    if(!this.config.invoiceAllowlist.includes(spec.invoiceId)||!this.config.allowedDialogs.includes(spec.origin?.chatId))throw Error('PAYMENT_NOT_ALLOWED');
    const result=await this.guard.execute(spec);
    if(result.status!=='confirmed')await this.recovery.refresh(result.id);
    return result;
  }
  close(){this.journal.close();}
}
