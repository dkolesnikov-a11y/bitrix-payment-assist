import {teamMembers} from './team.mjs';
export class Access {
 constructor(config,store){
  this.config=config;this.store=store;
  this.admins=config.adminUsers??[];
  store.db.exec(`CREATE TABLE IF NOT EXISTS bot_access(user_id INTEGER PRIMARY KEY,enabled INTEGER NOT NULL,from_event INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS bot_access_audit(event_id TEXT PRIMARY KEY,actor INTEGER NOT NULL,target INTEGER NOT NULL,action TEXT NOT NULL,created_at TEXT NOT NULL);`);
  this.baseUsers=[...config.allowedUsers];this.baseDialogs=[...config.allowedDialogs];this.refresh();
 }
 refresh(){
  const users=new Set([...this.baseUsers,...this.admins]),dialogs=new Set([...this.baseDialogs,...this.admins.map(String)]);
  this.config.accessFromEvents={};
  for(const row of this.store.db.prepare('SELECT * FROM bot_access').all()){
   this.config.accessFromEvents[row.user_id]=row.from_event;
   if(row.enabled){users.add(row.user_id);dialogs.add(String(row.user_id));}
   else if(!this.admins.includes(row.user_id)){users.delete(row.user_id);dialogs.delete(String(row.user_id));}
  }
  this.config.allowedUsers=[...users];this.config.allowedDialogs=[...dialogs];
 }
 accepts(author,dialog,eventId){
  if(/^\d+$/.test(dialog??'')&&dialog!==String(author))return false;
  const row=this.store.db.prepare('SELECT * FROM bot_access WHERE user_id=?').get(author);
  return !row||Boolean(row.enabled)&&Number(eventId)>row.from_event;
 }
 async handle(vibe,job,context){
  const text=context.text.trim();if(!/^\/?доступ(?:\s|$)/iu.test(text))return false;
  const reply=(message,mutation)=>this.store.finish(job.id,'done','ACCESS_COMMAND',{dialog:context.dialog,text:message},mutation);
  if(this.config.teamDialog){
   if(/^\/?доступ\s+список$/iu.test(text)){
    const members=await teamMembers(vibe,this.config);reply('Участники общего чата оплат: '+members.map(id=>'ID '+id).join(', ')+'.\nСостав меняется через список участников в шапке общего чата.');
   }else reply('Добавление и удаление сотрудников: откройте общий чат оплат → нажмите название чата → участники. Владелец чата управляет составом там; отдельная выдача доступа боту не нужна.');
   return true;
  }
  if(!this.admins.includes(context.author)||context.dialog!==String(context.author)){reply('Управлять доступом может только администратор в личном чате с ботом.');return true;}
  const match=text.match(/^\/?доступ\s+(добавить|убрать)\s+(\d+)$/iu);
  if(/^\/?доступ\s+список$/iu.test(text)){
   reply('Доступ к боту:\n'+this.config.allowedUsers.map(id=>`• ID ${id}${this.admins.includes(id)?' — администратор':''}`).join('\n'));return true;
  }
  if(!match){reply('Команды: «доступ список», «доступ добавить ID», «доступ убрать ID». ID сотрудника указан в ссылке на его профиль: /company/personal/user/ID/.');return true;}
  const target=Number(match[2]),add=match[1].toLowerCase()==='добавить';
  if(!Number.isSafeInteger(target)||target<=0||target===this.config.botId){reply('Укажите корректный ID сотрудника.');return true;}
  if(this.admins.includes(target)){reply('Доступ администратора защищен. Список администраторов задается в настройках сервиса.');return true;}
  if(add===this.config.allowedUsers.includes(target)){reply(add?'У сотрудника уже есть доступ.':'У сотрудника уже нет доступа.');return true;}
  if(add){
   try{const user=(await vibe.request('/users/'+target)).data;
    if(Number(user?.id)!==target||user.active===false||user.active==='N'||user.isActive===false)throw Error('INVALID_USER');
   }catch{reply('Не удалось подтвердить сотрудника в Битриксе. Доступ не изменен; проверьте ID и повторите команду.');return true;}
  }
  reply(add?`Сотруднику ID ${target} открыт доступ. Он может открыть «Помощник по оплатам» и отправить скриншот в личный чат с ботом.`:`Доступ сотрудника ID ${target} закрыт. Незавершенные выборы отменены. Уже отправленные в CRM платежи не отменяются.`,()=>{
   this.store.db.prepare('INSERT INTO bot_access VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled,from_event=excluded.from_event').run(target,add?1:0,Number(job.id));
   this.store.db.prepare('INSERT INTO bot_access_audit VALUES(?,?,?,?,?)').run(job.id,context.author,target,add?'grant':'revoke',new Date().toISOString());
   if(!add){
    this.store.db.prepare("UPDATE payment_dialogs SET state='access_revoked' WHERE author=? AND state NOT IN ('paid','payment_blocked')").run(target);
    this.store.db.prepare("UPDATE outbox SET state='cancelled' WHERE dialog=? AND state='pending'").run(String(target));
   }
  });
  this.refresh();return true;
 }
}
