const $=id=>document.getElementById(id),state={token:'',bot:null,bots:[],timer:null,busy:false,sendKey:null,session:0};
const labels={queued:'排队中',starting:'正在提交',running:'执行中',succeeded:'已完成',failed:'失败',unknown:'需要核对',cancelled:'已取消'};
function notify(text){$('notice').textContent=text;$('notice').classList.add('visible');setTimeout(()=>$('notice').classList.remove('visible'),4500);}
function element(tag,text,className){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;}
async function api(path,method='GET',body){const response=await fetch('/v1/bot'+path,{method,headers:{authorization:'Bearer '+state.token,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const value=await response.json();if(!response.ok)throw new Error(value.error??'请求失败');return value;}
function current(){if(!state.bot)throw new Error('请先选择或创建 Bot');return state.bot;}
async function refresh(){if(!state.token||state.busy)return;state.busy=true;const ticket=state.session;try{
  const bots=(await api('/bots')).items.filter(bot=>!bot.deleted);if(ticket!==state.session)return;state.bots=bots;if(state.bot)state.bot=bots.find(bot=>bot.botId===state.bot.botId)??null;if(!state.bot)state.bot=bots[0]??null;
  $('bots').replaceChildren();for(const bot of bots){const button=element('button',undefined,'bot'+(state.bot?.botId===bot.botId?' active':''));button.append(element('strong',bot.name),element('span',bot.role+(bot.enabled?'':' · 已暂停')));button.onclick=()=>{state.bot=bot;void refresh();};$('bots').append(button);}
  if(!state.bot)return;const botId=state.bot.botId;$('bot-title').textContent=state.bot.name;$('bot-description').textContent=state.bot.role;$('toggle-bot').textContent=state.bot.enabled?'暂停 Bot':'启用 Bot';
  const query='?botId='+encodeURIComponent(botId),[jobs,memory,schedules,outbox]=await Promise.all([api('/jobs'+query),api('/bots/'+botId+'/memory'),api('/schedules'+query),api('/outbox'+query)]);
  if(ticket!==state.session)return;$('messages').replaceChildren();for(const job of jobs.items.slice().reverse()){
    if(job.conversationId!==$('conversation-id').value)continue;
    const card=element('article',undefined,'job');card.append(element('div',job.errorCode==='run_cancelled'?'已取消':labels[job.status]??job.status,'status'),element('div',job.text,'request'));
    if(job.result?.text||job.resultText||job.result)card.append(element('div',typeof job.result==='string'?job.result:job.result?.text??job.resultText??'', 'answer'));
    if(job.errorCode||job.error_code)card.append(element('p',job.errorCode??job.error_code,'muted'));
    if(['queued','running'].includes(job.status)){const cancel=element('button','取消','quiet');cancel.onclick=()=>action(async()=>{await api('/jobs/'+job.id+'/cancel','POST',{});await refresh();});card.append(cancel);}
    if(job.status==='unknown'&&job.sessionId){const recover=element('button','按原任务核对并恢复','quiet');recover.onclick=()=>action(async()=>{await api('/jobs/'+job.id+'/resolve','POST',{});await refresh();});card.append(recover);}
    if(job.status==='unknown'&&!job.sessionId)card.append(element('p','会话创建结果待核对，需先绑定已确认的原会话；不会自动重新生成。','muted'));
    $('messages').append(card);
  }
  for(const output of outbox.items)if(output.channel==='web'&&output.status!=='delivered'&&jobs.items.some(job=>job.id===output.jobId&&job.conversationId===$('conversation-id').value))
    await api('/outbox/'+output.id+'/ack','POST',{deliveryKey:output.deliveryKey});
  $('memory').replaceChildren();for(const note of memory.items){const card=element('div',undefined,'note');card.append(element('strong',note.id),element('p',note.value));const remove=element('button','删除','quiet');remove.onclick=()=>action(async()=>{await api('/bots/'+botId+'/memory/'+encodeURIComponent(note.id),'DELETE');await refresh();});card.append(remove);$('memory').append(card);}
  $('schedules').replaceChildren();for(const schedule of schedules.items){const card=element('div',undefined,'routine');card.append(element('p',schedule.text),element('span',`${schedule.enabled?'已启用':'已暂停'} · 每 ${schedule.intervalMs/60000} 分钟`,'muted'));const toggle=element('button',schedule.enabled?'暂停':'启用','quiet');toggle.onclick=()=>action(async()=>{await api('/schedules/'+schedule.scheduleId+'/enabled','POST',{enabled:!schedule.enabled});await refresh();});card.append(toggle);$('schedules').append(card);}
}finally{if(ticket===state.session)state.busy=false;}}
async function action(fn){try{await fn();}catch(error){notify(error.message);}}
$('connect').onsubmit=event=>{event.preventDefault();void action(async()=>{state.session++;state.busy=false;state.token=$('token').value;$('token').value='';await refresh();$('login').hidden=true;$('workspace').hidden=false;$('connection').textContent='已连接 · Web';clearInterval(state.timer);state.timer=setInterval(()=>{void action(refresh);},1500);});};
$('disconnect').onclick=()=>{state.session++;state.token='';state.bot=null;state.bots=[];state.busy=false;state.sendKey=null;clearInterval(state.timer);for(const id of ['bots','messages','memory','schedules'])$(id).replaceChildren();$('workspace').hidden=true;$('login').hidden=false;$('connection').textContent='未连接';};
$('toggle-bot').onclick=()=>{void action(async()=>{const bot=current();await api('/bots/'+bot.botId+'/enabled','POST',{enabled:!bot.enabled});await refresh();});};
$('new-bot').onclick=()=>{$('bot-form').hidden=!$('bot-form').hidden;};
$('bot-form').onsubmit=event=>{event.preventDefault();void action(async()=>{state.bot=await api('/bots','POST',{name:$('bot-name').value,role:$('bot-role').value,instructions:$('bot-instructions').value});$('bot-form').reset();$('bot-form').hidden=true;await refresh();});};
$('send').onsubmit=event=>{event.preventDefault();void action(async()=>{const bot=current(),button=$('send').querySelector('button');button.disabled=true;
  try{const text=$('message').value,conversationId=$('conversation-id').value;
    const fingerprint=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))).map(value=>value.toString(16).padStart(2,'0')).join('');
    const cacheKey='dsh-bot.pending.'+bot.botId;let pending;
    try{pending=JSON.parse(sessionStorage.getItem(cacheKey)??'null');}catch{pending=null;}
    const eventId=pending?.conversationId===conversationId&&pending?.fingerprint===fingerprint?pending.eventId:crypto.randomUUID();
    // Persist only an event ID, scope and text hash, never credentials or raw text.
    sessionStorage.setItem(cacheKey,JSON.stringify({eventId,conversationId,fingerprint}));state.sendKey=eventId;
    await api('/messages','POST',{botId:bot.botId,eventId,conversationId,text});sessionStorage.removeItem(cacheKey);
    $('message').value='';state.sendKey=null;await refresh();
  }finally{button.disabled=false;}});};
$('message').oninput=()=>{state.sendKey=null;};
$('memory-form').onsubmit=event=>{event.preventDefault();void action(async()=>{await api('/bots/'+current().botId+'/memory','PUT',{id:$('memory-id').value,value:$('memory-value').value});$('memory-form').reset();await refresh();});};
$('schedule-form').onsubmit=event=>{event.preventDefault();void action(async()=>{await api('/schedules','POST',{botId:current().botId,conversationId:$('conversation-id').value,text:$('schedule-text').value,intervalMs:Number($('schedule-minutes').value)*60000,enabled:false});$('schedule-text').value='';await refresh();});};
$('refresh').onclick=()=>{void action(refresh);};$('conversation-id').onchange=()=>{void action(refresh);};
