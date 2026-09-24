export const isTeam=(config,dialog)=>Boolean(config.teamDialog)&&config.teamDialog===dialog;
export async function teamMembers(vibe,config){
 const result=await vibe.request(`/bots/${config.botId}/chats/${config.teamDialog}/users?limit=200`);
 if(!Array.isArray(result.data)||result.data.length>=200||result.meta?.hasMore===true)throw Error('TEAM_MEMBERS_UNVERIFIED');
 return result.data.filter(u=>u.active===true&&u.bot!==true&&u.type!=='bot').map(u=>Number(u.id)).filter(Number.isSafeInteger);
}
export async function teamAuthorized(vibe,config,author){return (await teamMembers(vibe,config)).includes(author);}
