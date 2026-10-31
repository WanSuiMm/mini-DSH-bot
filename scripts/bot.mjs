import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {BotStore} from '../service/bot/store.mjs';
import {BotRuntime} from '../service/bot/runtime.mjs';
import {BotServer} from '../service/bot/server.mjs';
import {HarnessClient} from '../service/bot/harness-client.mjs';

const args=process.argv.slice(2);let config=resolve(import.meta.dirname,'../configs/bot.example.json'),execute=false;
for(let i=0;i<args.length;i++){if(args[i]==='--config'&&args[i+1])config=resolve(args[++i]);else if(args[i]==='--execute')execute=true;else throw new Error('Use [--config PRIVATE_CONFIG] [--execute].');}
const settings=JSON.parse(readFileSync(config,'utf8'));
if(settings.schema!=='dsh-persistent-bot/v1'||!Array.isArray(settings.owners)||!settings.owners.length||settings.owners.length>16)throw new Error('invalid_bot_configuration');
for(const [key,min,max,fallback] of [['port',0,65535,8790],['max_active_jobs',1,8,2],['poll_interval_ms',100,60000,500],
  ['max_pending_jobs',1,1000,100],['max_owner_pending_jobs',1,1000,20],['max_retained_jobs',1,1000000,10000]]){
  settings[key]??=fallback;if(!Number.isSafeInteger(settings[key])||settings[key]<min||settings[key]>max)throw new Error('invalid_bot_limits');
}
if(typeof settings.database!=='string'||!settings.database.trim()||typeof settings.harness_url!=='string'||
  settings.max_owner_pending_jobs>settings.max_pending_jobs)throw new Error('invalid_bot_configuration');
if(!execute){console.log(JSON.stringify({status:'PLAN_ONLY',execution_enabled:settings.execution_enabled===true,channels:['web'],
  max_active_jobs:settings.max_active_jobs,model_calls:0,services_started:false,credential_values_read:false}));process.exit(0);}
if(settings.execution_enabled!==true)throw new Error('bot_execution_disabled');
const authTokens={},clients=new Map(),seen=new Set();
for(const entry of settings.owners){
  if(typeof entry.owner!=='string'||!entry.owner||clients.has(entry.owner))throw new Error('invalid_owner');
  for(const key of [entry.web_token_env,entry.harness_token_env])if(typeof key!=='string'||!/^[A-Z][A-Z0-9_]+$/.test(key))throw new Error('invalid_credential_reference');
  const web=process.env[entry.web_token_env],harness=process.env[entry.harness_token_env];
  if(!web||!harness||web.length<32||harness.length<32||seen.has(web)||seen.has(harness)||web===harness)throw new Error('distinct_private_tokens_required');
  seen.add(web);seen.add(harness);authTokens[web]=entry.owner;
  clients.set(entry.owner,new HarnessClient({baseUrl:settings.harness_url,token:harness}));
}
let store,runtime,server;
try{
  store=new BotStore(resolve(dirname(config),settings.database),{maxPending:settings.max_pending_jobs,maxOwnerPending:settings.max_owner_pending_jobs,maxEvents:settings.max_retained_jobs??10000});
  runtime=new BotRuntime({store,clientForOwner:owner=>clients.get(owner),maxActive:settings.max_active_jobs,intervalMs:settings.poll_interval_ms});
  server=new BotServer({store,runtime,authTokens});const {port}=await server.listen(settings.port);runtime.start();
  console.log(JSON.stringify({service:'dsh-bot',host:'127.0.0.1',port,channels:['web'],credential_values_logged:false}));
  let closing=false;
  const close=async()=>{if(closing)return;closing=true;await runtime.close();await server.close();store.close();};
  process.once('SIGINT',()=>{void close();});process.once('SIGTERM',()=>{void close();});
}catch{await runtime?.close();await server?.close();store?.close();throw new Error('bot_start_failed');}
