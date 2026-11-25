'use strict';
const $=s=>document.querySelector(s);
let bound=null,timer=null,running=false,profile={},generation=0;
async function api(type,data={},actionId){const result=await chrome.runtime.sendMessage({type,data,actionId});if(!result?.ok)throw Error(result?.error||'本地服务未响应');return result.data;}
async function page(type,extra={},expectedTabId=null){
  const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
  if(expectedTabId!==null&&tab?.id!==expectedTabId)throw Error('当前标签页已变化，任务已停止');
  if(!tab?.id||!/^https:\/\/www\.zhipin\.com\//.test(tab.url||'')&&!/^http:\/\/127\.0\.0\.1:8766\/boss-fixture(?:[?#]|$)/.test(tab.url||''))throw Error('请切换到 BOSS 页面或本机模拟页面');
  if(bound&&bound.tabId!==tab.id)throw Error('当前标签页已变化，请重新绑定');
  const result=await chrome.tabs.sendMessage(tab.id,{type,profile,...extra});
  if(!result?.ok)throw Error(result?.error||'页面脚本未就绪，请刷新 BOSS 页面');
  return {...result.data,tabId:tab.id};
}
function stop(){generation++;clearInterval(timer);timer=null;$('#sync').disabled=false;}
function status(text){$('#status').textContent=text;$('#error').textContent='';}
function failure(error){stop();bound=null;$('#fill-now').hidden=true;$('#error').textContent=error.message;$('#status').textContent='已停止，请检查后重新绑定或同步';}
function observation(snap,baseline=false){return {job_id:bound?.job_id||$('#job').value,binding:snap.binding,messages:snap.messages,capture_mode:snap.capture_mode||'stable',labels:snap.labels||null,baseline,confirmed:baseline};}
async function jobs(selected=$('#job').value){const data=await api('JOBS');$('#job').replaceChildren(new Option('请选择对应岗位',''),...data.jobs.map(j=>new Option(j.title+' · '+j.company,j.id)));$('#job').value=selected;}
$('#save-pair').onclick=async()=>{try{stop();bound=null;const result=await chrome.runtime.sendMessage({type:'SAVE_PAIR',value:$('#pair').value});if(!result?.ok)throw Error(result?.error||'保存失败');$('#pair').value='';await jobs();status('配对成功，请诊断岗位或绑定会话');}catch(e){failure(e);}};
$('#refresh-jobs').onclick=()=>jobs().catch(failure);
$('#boss-job-profile').onclick=async()=>{try{const example=await (await fetch(chrome.runtime.getURL('boss-job-list-profile.json'))).json();$('#profile').value=JSON.stringify(example,null,2);status('真实岗位列表配置已填入，请保存后诊断；该配置仅导入岗位，不启用聊天同步');}catch(e){failure(e);}};
$('#boss-chat-profile').onclick=async()=>{try{const example=await (await fetch(chrome.runtime.getURL('boss-chat-profile.json'))).json();$('#profile').value=JSON.stringify(example,null,2);status('求职聊天快照配置已填入，请保存后诊断。岗位导入仍可使用，聊天填入需逐次确认。');}catch(e){failure(e);}};
$('#inspect-page').onclick=async()=>{try{const structure=await page('INSPECT');$('#page-structure').value=JSON.stringify(structure,null,2);status('已读取可见页面结构，供校对选择器使用');}catch(e){failure(e);}};
$('#save-profile').onclick=async()=>{try{const parsed=JSON.parse($('#profile').value);stop();bound=null;profile=parsed;await chrome.storage.local.set({profile});status('配置已保存，请重新诊断并绑定');}catch(e){failure(e);}};
$('#fixture-profile').onclick=async()=>{try{const example=await (await fetch(chrome.runtime.getURL('fixture-profile.json'))).json();$('#profile').value=JSON.stringify(example,null,2);status('模拟配置已填入，请点击保存配置');}catch(e){failure(e);}};
let importBusy=false;
function importStatus(text,error=false){$('#job-import-status').textContent=text;$('#job-import-status').dataset.error=String(error);}
async function readImportJob(context=undefined,onDetail){
  context=context||await page('JOB_IMPORT_CONTEXT');if(context.kind==='job')return context.job;
  importStatus('正在打开当前聊天的岗位详情…');
  const existingTabs=new Set((await chrome.tabs.query({currentWindow:true})).map(tab=>tab.id));
  await page('OPEN_CHAT_JOB',{},context.tabId);
  const same=(a,b)=>a.replace(/\s/g,'').toLocaleLowerCase()===b.replace(/\s/g,'').toLocaleLowerCase();
  let last;
  for(let i=0;i<50;i++){
    const [active]=await chrome.tabs.query({active:true,currentWindow:true});
    if(active?.id===context.tabId){await new Promise(resolve=>setTimeout(resolve,300));continue;}
    if(active&&active.status!=='complete'){await new Promise(resolve=>setTimeout(resolve,300));continue;}
    if(!active||existingTabs.has(active.id)||(active.openerTabId!=null&&active.openerTabId!==context.tabId)||!/^https:\/\/www\.zhipin\.com\/job_detail\/[\w-]+\.html(?:[?#]|$)/.test(active.url||''))throw Error('导入过程中页面已变化，请在目标岗位详情页重新点击导入');
    try{
      const {tabId,...job}=await page('READ_DETAIL_JOB',{},active.id);
      if(!same(job.title,context.title)||(context.company&&!same(job.company,context.company)))throw Error('详情页的岗位或公司与刚才聊天不一致，已停止导入');
      if(onDetail)onDetail(active.id);
      return job;
    }catch(error){last=error;if(/不一致|登录|验证/.test(error.message))throw error;}
    await new Promise(resolve=>setTimeout(resolve,300));
  }
  throw Error(last?'岗位详情读取未完成：'+last.message:'未打开岗位详情，请在聊天中点击“查看职位”后重新导入');
}
async function readJobAction(importing){
  if(importBusy)return;
  if(importing&&!$('#job-consent').checked){importStatus('请先勾选上方“确认导入本机工作台”。',true);return;}
  importBusy=true;stop();bound=null;$('#fill-now').hidden=true;$('#import-job').disabled=true;$('#diagnose-job').disabled=true;
  importStatus(importing?'正在读取并导入当前岗位…':'正在读取当前岗位…');
  try{
    const snap=await readImportJob();$('#job-diagnosis').textContent=JSON.stringify(snap,null,2);
    if(!importing){importStatus('已读取 '+snap.company+' · '+snap.title+'，核对后可点击导入。');return;}
    const imported=await api('IMPORT_JOB',{...snap,confirmed:true});await jobs(imported.job_id);
    const message=imported.metadata_repaired?'该岗位已存在，已根据真实详情校正公司名称并选中原记录；投递进度已保留。':imported.existing?'该岗位已存在，已选中原记录；没有重复创建。如需更新正文，可点击下方“自动获取所选岗位JD”。':'已导入 '+snap.company+' · '+snap.title+'，请回工作台校对岗位要求。';
    importStatus(message);status(message);
  }catch(error){const message=/Receiving end|Could not establish connection|Extension context invalidated/.test(error.message)?'当前页面尚未载入扩展，请刷新这个BOSS页面后重试。':error.message;importStatus('未完成：'+message,true);}
  finally{importBusy=false;$('#import-job').disabled=false;$('#diagnose-job').disabled=false;}
}
$('#diagnose-job').onclick=()=>readJobAction(false);
$('#import-job').onclick=()=>readJobAction(true);
$('#preview-chat-job').onclick=async()=>{try{const snap=await page('READ_CHAT');if(!snap.labels)throw Error('请先使用聊天快照配置');$('#chat-job-title').value=snap.labels.position.split('\n')[0].trim();$('#chat-job-company').value=snap.labels.conversation.split('\n')[1]?.trim()||'';$('#chat-job-fields').hidden=false;status('请核对岗位与公司名称；建立后按上方设置获取JD，匹配前仍需校对要求。');}catch(e){failure(e);}};
$('#create-chat-job').onclick=async()=>{try{if(!$('#chat-consent').checked)throw Error('请先核对当前会话并勾选确认');$('#create-chat-job').disabled=true;const snap=await page('READ_CHAT');const result=await api('IMPORT_CHAT_JOB',{title:$('#chat-job-title').value.trim(),company:$('#chat-job-company').value.trim(),position:snap.labels.position,confirmed:true});stop();bound=null;await jobs(result.job_id);$('#chat-job-fields').hidden=true;status('聊天岗位已建立，可核对后绑定当前会话。JD获取结果见上方提示。');autoFetchJobJD(result.job_id);}catch(e){failure(e);}finally{$('#create-chat-job').disabled=false;}};
$('#diagnose-chat').onclick=async()=>{try{const snap=await page('READ_CHAT');$('#chat-diagnosis').textContent=JSON.stringify({mode:snap.capture_mode||'stable',labels:snap.labels,binding:snap.binding,needs_bind:snap.needs_bind,visible_messages:snap.messages.length},null,2);status(snap.capture_mode==='snapshot'?'已读取当前会话预览；请核对显示账号、招聘方、岗位后绑定。本模式不自动填入草稿。':'请核对账号、岗位和招聘方会话ID');}catch(e){failure(e);}};
$('#bind').onclick=async()=>{try{stop();bound=null;if(!$('#chat-consent').checked||!$('#job').value)throw Error('请选择内部岗位并确认会话范围');const snap=await page('BIND_CHAT');await api('OBSERVE',observation(snap,true));bound={tabId:snap.tabId,binding:snap.binding,job_id:$('#job').value,captureMode:snap.capture_mode||'stable'};$('#chat-diagnosis').textContent=JSON.stringify({mode:bound.captureMode,labels:snap.labels,visible_messages:snap.messages.length},null,2);$('#fill-now').hidden=bound.captureMode!=='snapshot';status(bound.captureMode==='snapshot'?'本次页面会话已绑定。可同步可见消息；每条草稿需在此点击确认填入，切换页面后重新绑定。':'会话已绑定；历史消息只作基线。可开始同步。');autoFetchJobJD(bound.job_id);}catch(e){failure(e);}};
async function tick(manual=false){
  if(running)return;running=true;const activeGeneration=generation;let action=null,attempted=false;
  try{
    if(!bound)throw Error('请先绑定当前会话');
    const snap=await page('READ_CHAT');
    if(JSON.stringify(snap.binding)!==JSON.stringify(bound.binding)||$('#job').value!==bound.job_id)throw Error('账号、岗位或招聘方会话变化，请重新绑定');
    if(snap.needs_bind||!snap.binding)throw Error('页面会话已失效，请重新核对并绑定');
    const observed=await api('OBSERVE',observation(snap));
    if(activeGeneration!==generation)return;
    if(bound.captureMode==='snapshot'&&!manual){status('可见消息快照同步中 · '+new Date().toLocaleTimeString()+' · 填入需在此逐次确认');return;}
    action=(await api('CLAIM',{job_id:bound.job_id,binding:snap.binding,fingerprint:observed.fingerprint,manual_confirmed:manual===true})).action;
    if(!action){status(manual?'没有可填入的已确认草稿，请先在工作台保存并批准。':'同步中 · '+new Date().toLocaleTimeString()+' · 未发送任何消息');return;}
    if(activeGeneration!==generation)throw Error('同步已停止，草稿未填入');
    attempted=true;
    await page('FILL',{action,expected:{binding:snap.binding,messages:snap.messages},manual_confirmed:manual===true});
    await api('RESULT',{lease:action.lease,outcome:'FILLED'},action.id);
    status('已填入你确认的草稿，请在 BOSS 页面核对后自行发送。');
  }catch(e){if(action){try{await api('RESULT',{lease:action.lease,outcome:attempted?'UNKNOWN':'FAILED'},action.id);}catch{}}failure(e);}
  finally{running=false;}
}
$('#sync').onclick=()=>{if(!bound){failure(Error('请先绑定会话'));return;}if(timer)return;$('#sync').disabled=true;timer=setInterval(tick,4000);void tick();};
$('#fill-now').onclick=async()=>{if(!bound||bound.captureMode!=='snapshot'){failure(Error('请先核对并绑定当前页面会话'));return;}if(running){status('正在同步，请稍后再点击填入');return;}$('#fill-now').disabled=true;try{await tick(true);}finally{$('#fill-now').disabled=false;}};
$('#stop').onclick=()=>{stop();void page('UNBIND_CHAT').catch(()=>{});bound=null;$('#fill-now').hidden=true;status('已停止同步并解除本次页面绑定，已填入的草稿请在平台自行核对。');};
$('#job').onchange=()=>{stop();bound=null;status('岗位已切换，请重新绑定会话');};
window.addEventListener('pagehide',stop);
chrome.tabs.onActivated.addListener(({tabId})=>{if(bound&&tabId!==bound.tabId){stop();status('已离开绑定页面，暂停同步。返回原页后核对当前会话，再手动恢复同步或填入；页面刷新后需重新绑定。');}});
(async()=>{const saved=await chrome.storage.local.get('profile');profile=saved.profile||{};$('#profile').value=JSON.stringify(profile,null,2);const result=await chrome.runtime.sendMessage({type:'STATUS'});if(result?.data?.paired){await jobs();status('已配对，请诊断并绑定页面');}})().catch(failure);
