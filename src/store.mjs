import {DatabaseSync} from 'node:sqlite';
export class Store{
  constructor(path){this.db=new DatabaseSync(path);this.db.exec(`PRAGMA busy_timeout=5000;PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS inbox(id TEXT PRIMARY KEY,body TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',reason TEXT);
    CREATE TABLE IF NOT EXISTS artifacts(event_id TEXT NOT NULL,file_id INTEGER NOT NULL,hash TEXT NOT NULL,mime TEXT NOT NULL,path TEXT NOT NULL,PRIMARY KEY(event_id,file_id));
    CREATE TABLE IF NOT EXISTS extracted(event_id TEXT NOT NULL,file_id INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(event_id,file_id));
    CREATE TABLE IF NOT EXISTS matches(event_id TEXT PRIMARY KEY,body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS image_routes(event_id TEXT PRIMARY KEY,source_dialog TEXT NOT NULL,target_dialog TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS payment_dialogs(source_event TEXT NOT NULL,payment_index INTEGER NOT NULL,dialog TEXT NOT NULL,author INTEGER NOT NULL,state TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(source_event,payment_index));
    CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,event_id TEXT NOT NULL,dialog TEXT NOT NULL,text TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',remote_id TEXT);`);
    if(!this.db.prepare('PRAGMA table_info(outbox)').all().some(x=>x.name==='keyboard'))this.db.exec('ALTER TABLE outbox ADD COLUMN keyboard TEXT');
    if(!this.db.prepare('PRAGMA table_info(outbox)').all().some(x=>x.name==='command_reply'))this.db.exec('ALTER TABLE outbox ADD COLUMN command_reply TEXT');
    if(!this.db.prepare('PRAGMA table_info(outbox)').all().some(x=>x.name==='forward_ids'))this.db.exec('ALTER TABLE outbox ADD COLUMN forward_ids TEXT');
    if(!this.db.prepare('PRAGMA table_info(outbox)').all().some(x=>x.name==='image_file_id'))this.db.exec('ALTER TABLE outbox ADD COLUMN image_file_id INTEGER');
  }
  tx(fn){this.db.exec('BEGIN IMMEDIATE');try{const v=fn();this.db.exec('COMMIT');return v;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  cursor(){return Number(this.db.prepare("SELECT value FROM settings WHERE key='offset'").get()?.value??0);}
  ingest(page){
    if(!Array.isArray(page.events)||!Number.isSafeInteger(page.nextOffset)||page.nextOffset<this.cursor())throw Error('INVALID_EVENT_PAGE');
    this.tx(()=>{
      for(const event of page.events){
        if(!Number.isSafeInteger(event.eventId)||event.eventId<0)throw Error('INVALID_EVENT');
        const id=String(event.eventId),body=JSON.stringify(event),old=this.db.prepare('SELECT body FROM inbox WHERE id=?').get(id);
        if(old&&old.body!==body)throw Error('EVENT_ID_COLLISION');
        this.db.prepare('INSERT OR IGNORE INTO inbox(id,body) VALUES(?,?)').run(id,body);
      }
      this.db.prepare("INSERT INTO settings(key,value) VALUES('offset',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(page.nextOffset));
    });
  }
  pending(){return this.db.prepare("SELECT * FROM inbox WHERE state='pending' ORDER BY CAST(id AS INTEGER) LIMIT 100").all();}
  finish(id,state,reason,message,mutation){this.tx(()=>{
    mutation?.();
    if(message)this.db.prepare('INSERT OR IGNORE INTO outbox(id,event_id,dialog,text) VALUES(?,?,?,?)').run('event:'+id,id,message.dialog,message.text);
    if(message?.keyboard)this.db.prepare("UPDATE outbox SET keyboard=? WHERE id=? AND state='pending'").run(JSON.stringify(message.keyboard),'event:'+id);
    if(message?.commandReply)this.db.prepare("UPDATE outbox SET command_reply=? WHERE id=? AND state='pending'").run(JSON.stringify(message.commandReply),'event:'+id);
    this.db.prepare('UPDATE inbox SET state=?,reason=? WHERE id=?').run(state,reason,id);
  });}
  claimReply(){return this.tx(()=>{const row=this.db.prepare("SELECT * FROM outbox WHERE state='pending' ORDER BY rowid LIMIT 1").get();if(!row)return null;this.db.prepare("UPDATE outbox SET state='sending' WHERE id=?").run(row.id);return row;});}
  close(){this.db.close();}
}
