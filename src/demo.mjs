import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from './store.mjs';
import {Service} from './service.mjs';
import {Ocr} from './ocr.mjs';
const dir=await mkdtemp(join(tmpdir(),'payment-bot-demo-'));
const c={dataDir:dir,botId:900,allowedUsers:[49],allowedDialogs:['49'],invoiceAllowlist:[2381],crmWrites:false,sendMessages:false};
const store=new Store(join(dir,'service.sqlite'));
const fake={download:async()=>({bytes:Buffer.from([137,80,78,71,13,10,26,10]),mime:'image/png'})};
const service=new Service(c,store,fake,new Ocr({url:''}));
try{
  store.ingest({events:[{eventId:1,type:'ONIMBOTV2MESSAGEADD',data:{bot:{id:900},dialogId:'49',message:{id:1,authorId:49,params:{FILE_ID:['1']}}}}],nextOffset:2});
  await service.process();
  console.log(JSON.stringify({mode:'offline-demo',crmWrites:false,messagesSent:0,
    jobs:store.db.prepare('SELECT id,state,reason FROM inbox').all(),
    replies:store.db.prepare('SELECT dialog,text,state FROM outbox').all()},null,2));
}finally{service.close();store.close();await rm(dir,{recursive:true,force:true});}
