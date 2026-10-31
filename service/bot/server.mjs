import {createServer} from 'node:http';
import {createHash,timingSafeEqual} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';

const digest=value=>createHash('sha256').update(value).digest();
const webRoot=resolve(import.meta.dirname,'../../web-bot');
export class BotServer {
  constructor({store,runtime,authTokens,maxBodyBytes=64000}){
    if(!authTokens||!Object.keys(authTokens).length)throw new Error('bot_auth_required');
    this.tokens=Object.entries(authTokens).map(([token,owner])=>{if(typeof token!=='string'||!token||typeof owner!=='string'||!owner)throw new Error('bot_auth_invalid');return {digest:digest(token),owner};});
    this.store=store;this.runtime=runtime;this.maxBodyBytes=maxBodyBytes;
    this.server=createServer((req,res)=>{void this.handle(req,res);});this.server.requestTimeout=10000;this.server.headersTimeout=5000;this.active=0;
  }
  send(res,status,value){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));}
  owner(req){const value=/^Bearer (.{1,4096})$/.exec(req.headers.authorization??'')?.[1];
    if(!value)throw Object.assign(new Error('authentication_required'),{status:401});
    const hashed=digest(value),found=this.tokens.find(entry=>timingSafeEqual(entry.digest,hashed));
    if(!found)throw Object.assign(new Error('authentication_failed'),{status:401});return found.owner;}
  async body(req,allowed,required=[]){
    if(!String(req.headers['content-type']??'').startsWith('application/json'))throw Object.assign(new Error('json_required'),{status:415});
    let size=0;const chunks=[];
    for await(const chunk of req){size+=chunk.length;if(size>this.maxBodyBytes)throw Object.assign(new Error('body_limit'),{status:413});chunks.push(chunk);}
    let result;try{result=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{throw Object.assign(new Error('invalid_json'),{status:400});}
    if(!result||Array.isArray(result)||typeof result!=='object'||Object.keys(result).some(key=>!allowed.includes(key))||required.some(key=>!(key in result)))
      throw Object.assign(new Error('invalid_fields'),{status:400});return result;
  }
  async handle(req,res){
    if(++this.active>16){this.active--;this.send(res,503,{error:'request_capacity'});req.resume();return;}
    try{
      const host=req.headers.host??'',url=new URL(req.url,'http://'+host);
      if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.port!==String(this.port))throw Object.assign(new Error('invalid_host'),{status:400});
      if(req.headers.origin&&req.headers.origin!==url.origin)throw Object.assign(new Error('cross_origin_rejected'),{status:403});
      const path=url.pathname;
      if(req.method==='GET'&&path==='/healthz'){this.send(res,200,{status:'ok',scope:'process_only'});return;}
      const asset={'/':['index.html','text/html'],'/app.mjs':['app.mjs','text/javascript'],'/styles.css':['styles.css','text/css']}[path];
      if(asset&&req.method==='GET'&&!url.search){res.writeHead(200,{'Content-Type':asset[1]+'; charset=utf-8','Cache-Control':'no-store',
        'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});res.end(readFileSync(join(webRoot,asset[0])));return;}
      const owner=this.owner(req),s=this.store,parts=path.split('/').filter(Boolean);
      if(parts[0]!=='v1'||parts[1]!=='bot')throw Object.assign(new Error('not_found'),{status:404});
      if([...url.searchParams.keys()].some(key=>key!=='botId'))throw Object.assign(new Error('invalid_query'),{status:400});
      const botId=url.searchParams.get('botId')??undefined;
      if(path==='/v1/bot/bots'){
        if(req.method==='GET'){this.send(res,200,{items:s.listBots(owner)});return;}
        if(req.method==='POST'){this.send(res,201,s.createBot({owner,...await this.body(req,['name','role','instructions'],['name','role'])}));return;}
      }
      if(parts[2]==='bots'&&parts[3]){
        const id=parts[3];s.getBot(owner,id);
        if(parts.length===4&&req.method==='GET'){this.send(res,200,s.getBot(owner,id));return;}
        if(parts.length===5&&parts[4]==='enabled'&&req.method==='POST'){
          const body=await this.body(req,['enabled'],['enabled']);if(typeof body.enabled!=='boolean')throw Object.assign(new Error('boolean_required'),{status:400});
          this.send(res,200,s.setBotEnabled(owner,id,body.enabled));return;}
        if(parts[4]==='memory'&&parts.length===5){
          if(req.method==='GET'){this.send(res,200,{items:s.listMemory(owner,id)});return;}
          if(req.method==='PUT'){this.send(res,200,s.putMemory(owner,id,await this.body(req,['id','value'],['id','value'])));return;}
        }
        if(parts[4]==='memory'&&parts.length===6&&req.method==='DELETE'){this.send(res,200,{deleted:s.deleteMemory(owner,id,decodeURIComponent(parts[5]))});return;}
        if(parts[4]==='bind-session'&&parts.length===5&&req.method==='POST'){
          const body=await this.body(req,['conversationId','sessionId'],['conversationId','sessionId']);
          this.send(res,200,await this.runtime.bindSession(owner,id,body.conversationId,body.sessionId));return;}
      }
      if(path==='/v1/bot/messages'&&req.method==='POST'){
        const input=await this.body(req,['botId','eventId','conversationId','text'],['botId','eventId','conversationId','text']);
        const saved=s.ingest({owner,channel:'web',...input});this.send(res,saved.replayed?200:202,saved);return;}
      if(path==='/v1/bot/jobs'&&req.method==='GET'){this.send(res,200,{items:s.listJobs(owner,{botId,limit:100})});return;}
      if(parts[2]==='jobs'&&parts[3]){
        const id=parts[3];s.getJob(owner,id);
        if(parts.length===4&&req.method==='GET'){this.send(res,200,s.getJob(owner,id));return;}
        if(parts.length===5&&parts[4]==='cancel'&&req.method==='POST'){await this.body(req,[]);this.send(res,200,await this.runtime.cancel(owner,id));return;}
        if(parts.length===5&&parts[4]==='reconcile'&&req.method==='POST'){
          const body=await this.body(req,['runId'],['runId']);this.send(res,200,await this.runtime.reconcile(owner,id,body.runId));return;}
        if(parts.length===5&&parts[4]==='resolve'&&req.method==='POST'){
          await this.body(req,[]);this.send(res,200,await this.runtime.resolveUnknown(owner,id));return;}
      }
      if(path==='/v1/bot/outbox'&&req.method==='GET'){this.send(res,200,{items:s.listOutbox(owner,{botId,limit:100})});return;}
      if(parts[2]==='outbox'&&parts.length===5&&parts[4]==='ack'&&req.method==='POST'){
        const body=await this.body(req,['deliveryKey'],['deliveryKey']);this.send(res,200,s.ackWebOutbox(owner,parts[3],body.deliveryKey));return;}
      if(path==='/v1/bot/schedules'){
        if(req.method==='GET'){this.send(res,200,{items:s.listSchedules(owner,{botId,limit:100})});return;}
        if(req.method==='POST'){
          const body=await this.body(req,['botId','conversationId','text','intervalMs','enabled'],['botId','conversationId','text','intervalMs']);
          this.send(res,201,s.addSchedule({owner,channel:'web',anchorAt:Date.now(),...body}));return;}
      }
      if(parts[2]==='schedules'&&parts.length===5&&parts[4]==='enabled'&&req.method==='POST'){
        const body=await this.body(req,['enabled'],['enabled']);if(typeof body.enabled!=='boolean')throw Object.assign(new Error('boolean_required'),{status:400});
        this.send(res,200,s.setScheduleEnabled(owner,parts[3],body.enabled));return;}
      throw Object.assign(new Error('not_found'),{status:404});
    }catch(error){const code=typeof error.code==='string'?error.code:typeof error.message==='string'&&/^[a-z_]+$/.test(error.message)?error.message:'operation_failed';
      if(!res.headersSent)this.send(res,error.status??(code==='operation_failed'?500:400),{error:code});else res.end();req.resume();}
    finally{this.active--;}
  }
  async listen(port=0){if(!Number.isSafeInteger(port)||port<0||port>65535)throw new Error('invalid_port');await new Promise((resolve,reject)=>{this.server.once('error',reject);this.server.listen(port,'127.0.0.1',resolve);});this.port=this.server.address().port;return {port:this.port};}
  async close(){this.server.closeAllConnections();if(this.server.listening)await new Promise(resolve=>this.server.close(resolve));}
}
