import http from 'node:http';
import {spawn} from 'node:child_process';
import {mkdirSync,existsSync,readFileSync,writeFileSync,unlinkSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
const root=process.env.BOT_STATE_ROOT??'/data/payment-helper';
mkdirSync(root,{recursive:true,mode:0o700});
if(process.env.VIBE_API_KEY){
 if(!/^vibe_api_\S+$/.test(process.env.VIBE_API_KEY))throw Error('INVALID_KEY_ENV');
 writeFileSync(root+'/api-key.txt',process.env.VIBE_API_KEY,{mode:0o600});
 delete process.env.VIBE_API_KEY;
}
let child=null,stopping=false,lastExit=null;
const enabled=()=>existsSync(root+'/ACTIVE');
function status(){
 let heartbeat=null;try{heartbeat=JSON.parse(readFileSync(root+'/heartbeat.json','utf8'));}catch{}
 return {state:!enabled()?'standby':child?'running':'starting',workerAlive:!!child,lastExit,lastCycle:heartbeat?.at??null,node:process.version};
}
function start(){
 if(stopping||child||!enabled())return;
 if(!existsSync(root+'/MIGRATED'))throw Error('MIGRATION_REQUIRED');
 const c=JSON.parse(readFileSync(root+'/config.json','utf8'));
 if(c.botId!==75325||c.dataDir!==root)throw Error('WRONG_CONFIG');
 for(const name of ['service','payments']){
  const db=new DatabaseSync(root+'/'+name+'.sqlite',{readOnly:true});
  if(db.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw Error('DATABASE_INVALID');
  db.close();
 }
 // Outer flock serializes supervisors; remove only the prior child's stale lock.
 const lock=root+'/service.lock';
 if(existsSync(lock)){
  const pid=Number(readFileSync(lock,'utf8'));
  if(!Number.isSafeInteger(pid)||pid<=0)throw Error('INVALID_LOCK');
  try{process.kill(pid,0);throw Error('WORKER_ALREADY_RUNNING');}catch(e){if(e.code!=='ESRCH')throw e;}
  unlinkSync(lock);
 }
 child=spawn(process.execPath,['src/main.mjs'],{cwd:'/opt/app',stdio:'inherit',env:{...process.env,BOT_CONFIG:root+'/config.json',BOT_HEARTBEAT_FILE:root+'/heartbeat.json'}});
 child.once('exit',(code)=>{lastExit=code;child=null;});
}
const timer=setInterval(()=>{try{start();}catch(e){console.error(e.message);}},5000);
const server=http.createServer((req,res)=>{
 if(!['/','/health'].includes(req.url)){res.writeHead(404);res.end();return;}
 const s=status(),healthy=s.state==='standby'||s.workerAlive&&s.lastCycle&&Date.now()-Date.parse(s.lastCycle)<180000;
 res.writeHead(healthy?200:503,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(s));
});
server.listen(Number(process.env.PORT??3000),'0.0.0.0');
function stop(){if(stopping)return;stopping=true;clearInterval(timer);child?.kill('SIGTERM');server.close();const t=setInterval(()=>{if(!child){clearInterval(t);process.exit(0);}},250);}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
writeFileSync(root+'/supervisor.pid',String(process.pid),{mode:0o600});
console.log('Payment hosting ready; processing requires migrated state and ACTIVE marker');
