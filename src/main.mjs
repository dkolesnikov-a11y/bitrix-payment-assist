import {mkdir,open,unlink,writeFile,rename} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {setTimeout as pause} from 'node:timers/promises';
import {config} from './config.mjs';
import {Vibe} from './vibe.mjs';
import {Store} from './store.mjs';
import {Ocr} from './ocr.mjs';
import {VibeOcr} from './vibe-ocr.mjs';
import {Service} from './service.mjs';

let store,service,lock,lockPath,ownsLock=false;
try{
  const c=await config(process.env.BOT_CONFIG??'config.local.json');
  if(existsSync(join(c.dataDir,'REMOTE_ACTIVE')))throw Error('BOT_MOVED_TO_GALAXY');
  await mkdir(c.dataDir,{recursive:true});lockPath=join(c.dataDir,'service.lock');
  lock=await open(lockPath,'wx');ownsLock=true;await lock.writeFile(String(process.pid));
  const vibe=await Vibe.create(c);await vibe.verify();
  if(!c.botId)throw Error('REGISTER_BOT_AND_SET_BOT_ID');
  store=new Store(join(c.dataDir,'service.sqlite'));service=new Service(c,store,vibe,c.ocr.provider==='vibe'?new VibeOcr(c.keyFile):new Ocr(c.ocr));
  let running=true;process.once('SIGINT',()=>{running=false;});process.once('SIGTERM',()=>{running=false;});
  console.log(JSON.stringify({status:'started',botId:c.botId,crmWrites:c.crmWrites,sendMessages:c.sendMessages,ocrConfigured:c.ocr.provider==='vibe'||!!c.ocr.url}));
  do{
    try{const page=await service.cycle();if(process.env.BOT_HEARTBEAT_FILE){const path=process.env.BOT_HEARTBEAT_FILE;await writeFile(path+".tmp",JSON.stringify({at:new Date().toISOString()}),{mode:0o600});await rename(path+".tmp",path);}if(process.argv.includes('--once'))break;if(!page.hasMore)await pause(c.pollIntervalMs);}
    catch{console.error('CYCLE_FAILED_CHECK_LOCAL_STATE');if(process.argv.includes('--once')){process.exitCode=1;break;}await pause(c.pollIntervalMs);}
  }while(running);
}catch(error){
  console.error(['BOT_MOVED_TO_GALAXY','REGISTER_BOT_AND_SET_BOT_ID','KEY_PORTAL_MISMATCH','INVALID_VIBE_KEY'].includes(error.message)?error.message:'START_FAILED_CHECK_CONFIG_OR_PROCESS_LOCK');process.exitCode=1;
}finally{
  service?.close();store?.close();await lock?.close();if(ownsLock)await unlink(lockPath);
}
