// Explicit one-time setup, never called by the runtime loop.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {config} from './config.mjs';
import {Vibe} from './vibe.mjs';
const c=await config('config.example.json'),api=await Vibe.create(c);await api.verify();
const code='payment_helper_p18_2026';
const listing=(await api.request('/bots')).data;
if(listing.hasNextPage)throw Error('BOT_LIST_PAGINATION_REQUIRES_REVIEW');
const existing=listing.bots.find(x=>x.code===code);
await mkdir('var',{recursive:true});
let botId=Number(existing?.id);
if(!existing){
  await writeFile('var/bot-registration-intent.json',JSON.stringify({code,at:new Date().toISOString()}),{flag:'wx'});
  const result=await api.request('/bots','POST',{code,name:'Помощник по оплатам',type:'bot',eventMode:'fetch'});
  await writeFile('var/bot-registration-result.json',JSON.stringify(result,null,2),{flag:'wx'});
  botId=Number(result.data.botId);
}
if(!Number.isSafeInteger(botId)||botId<=0)throw Error('BOT_ID_UNKNOWN_DO_NOT_REREGISTER');
const local={...JSON.parse(await readFile('config.example.json','utf8')),botId,sendMessages:true,crmWrites:false};
await writeFile('config.local.json',JSON.stringify(local,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({botId,code,crmWrites:false,allowedUsers:local.allowedUsers,allowedDialogs:local.allowedDialogs}));
