import http from 'node:http';
import https from 'node:https';

export class BotPeerError extends Error {
  constructor(code,{uncertain=false,status=null}={}){super(code);this.code=code;this.uncertain=uncertain;this.status=status;}
}
export class HarnessClient {
  constructor({baseUrl,token,timeoutMs=3000}){
    const url=new URL(baseUrl);
    if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||
      !['http:','https:'].includes(url.protocol)||url.protocol==='http:'&&!['127.0.0.1','localhost','[::1]'].includes(url.hostname))
      throw new Error('invalid_harness_origin');
    if(typeof token!=='string'||!token||token.length>4096||!/^[\x21-\x7e]+$/.test(token))throw new Error('invalid_harness_token');
    if(!Number.isSafeInteger(timeoutMs)||timeoutMs<100||timeoutMs>30000)throw new Error('invalid_timeout');
    this.origin=url.origin;this.token=token;this.timeoutMs=timeoutMs;
  }
  async request(path,method='GET',body,key){
    const mutating=method!=='GET',url=new URL(path,this.origin),payload=body===undefined?null:Buffer.from(JSON.stringify(body));
    if(url.origin!==this.origin||payload?.length>128000)throw new BotPeerError('request_invalid');
    return new Promise((resolve,reject)=>{
      let settled=false,bytes=0;const chunks=[];
      const fail=(code,status=null)=>{if(settled)return;settled=true;clearTimeout(timer);req.destroy();reject(new BotPeerError(code,{status,uncertain:mutating}));};
      const req=(url.protocol==='https:'?https:http).request(url,{method,agent:false,maxHeaderSize:16384,
        headers:{authorization:'Bearer '+this.token,accept:'application/json',connection:'close',
          ...(payload?{'content-type':'application/json','content-length':payload.length}:{}),...(key?{'idempotency-key':key}:{})}},res=>{
        res.on('data',chunk=>{bytes+=chunk.length;if(bytes>262144){res.destroy();fail('response_limit',res.statusCode);}else chunks.push(chunk);});
        res.on('error',()=>fail('transport_error',res.statusCode));
        res.on('end',()=>{
          if(settled)return;settled=true;clearTimeout(timer);
          const status=res.statusCode??0;
          if(status<200||status>=300){reject(new BotPeerError('harness_http_error',{status,uncertain:mutating&&!(status>=400&&status<500)}));return;}
          try{if(!String(res.headers['content-type']).startsWith('application/json'))throw new Error();
            resolve(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))));}
          catch{reject(new BotPeerError('invalid_response',{uncertain:mutating}));}
        });
      });
      const timer=setTimeout(()=>fail('harness_timeout'),this.timeoutMs);
      req.on('error',()=>fail('transport_error'));req.end(payload??undefined);
    });
  }
  createSession(title){return this.request('/v1/sessions','POST',{title});}
  getSession(id){return this.request('/v1/sessions/'+encodeURIComponent(id));}
  startRun(sessionId,input,key){return this.request('/v1/sessions/'+encodeURIComponent(sessionId)+'/runs','POST',input,key);}
  getRun(id){return this.request('/v1/runs/'+encodeURIComponent(id));}
  lookupRun(sessionId,key){return this.request('/v1/sessions/'+encodeURIComponent(sessionId)+'/run-lookup?key='+encodeURIComponent(key));}
  cancelRun(id){return this.request('/v1/runs/'+encodeURIComponent(id)+'/cancel','POST',{});}
}
