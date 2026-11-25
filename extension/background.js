'use strict';
chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:true});
const routes={JOBS:['GET','/jobs'],IMPORT_JOB:['POST','/jobs'],IMPORT_CHAT_JOB:['POST','/chat-job'],OBSERVE:['POST','/observations'],CLAIM:['POST','/claim'],SEARCH:['GET','/search'],COLLECT:['POST','/opportunities'],AUTO_DRAFTS:['POST','/applications/drafts'],APPLICATIONS:['GET','/applications'],APP_CLAIM:['POST','/applications/claim']};
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  if(sender.id!==chrome.runtime.id||sender.url!==chrome.runtime.getURL('panel.html'))return false;
  (async()=>{
    if(message.type==='SAVE_PAIR'){
      const pair=JSON.parse(message.value);
      if(pair.base!=='http://127.0.0.1:8766'||!/^[a-f0-9]{32}$/.test(pair.connection_id)||! /^[\w-]{32,100}$/.test(pair.token))throw Error('请粘贴求职 Agent 8766端口生成的有效配对凭证');
      await chrome.storage.local.set({pair});return {saved:true};
    }
    if(message.type==='STATUS'){const {pair}=await chrome.storage.local.get('pair');return {paired:!!pair,connection_id:pair?.connection_id};}
    const {pair}=await chrome.storage.local.get('pair');if(!pair)throw Error('请先配对本机工作台');
    if(message.type==='FETCH_JOB_HTML'){
      const url=new URL(message.data.url);
      if(url.origin!=='https://www.zhipin.com'||url.username||url.password||!/^\/job_detail\/[\w-]+\.html$/.test(url.pathname))throw Error('只允许获取BOSS官方岗位详情');
      const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),12000);
      try{
        const response=await fetch(url.origin+url.pathname,{credentials:'include',redirect:'error',signal:controller.signal});
        if(!response.ok||!(response.headers.get('content-type')||'').includes('text/html'))throw Error('岗位详情暂不可读取，请在浏览器打开后重试');
        const html=await response.text();if(html.length>2000000)throw Error('岗位页面过大，已停止读取');
        return {html,url:url.origin+url.pathname};
      }catch(error){if(error.name==='AbortError')throw Error('获取JD超时，请打开岗位详情后重试');throw error;}
      finally{clearTimeout(timeout);}
    }
    let method,path;
    if(routes[message.type])[method,path]=routes[message.type];
    else if(message.type==='UPDATE_JOB_JD'&&/^[a-f0-9]{32}$/.test(message.actionId)){method='POST';path='/jobs/'+message.actionId+'/jd';}
    else if(message.type==='RESULT'&&/^[a-f0-9]{32}$/.test(message.actionId)){method='POST';path='/actions/'+message.actionId+'/result';}
    else if(message.type==='APP_RECEIPTS'){method='GET';path='/applications/receipts';}
    else if(['APP_PREFLIGHT','APP_RESULT','APP_STOP','APP_SYNC','APP_DISPATCH'].includes(message.type)&&/^[a-f0-9]{32}$/.test(message.actionId)){method='POST';path='/applications/'+message.actionId+'/'+({APP_DISPATCH:'dispatch',APP_PREFLIGHT:'preflight',APP_RESULT:'result',APP_STOP:'cancel',APP_SYNC:'sync'}[message.type]);}
    else throw Error('不支持的连接器操作');
    const response=await fetch(pair.base+'/api/connector/'+pair.connection_id+path,{method,credentials:'omit',redirect:'error',headers:{Authorization:'Bearer '+pair.token,'Content-Type':'application/json'},...(method==='POST'?{body:JSON.stringify(message.data)}:{})});
    const body=await response.json();if(!response.ok)throw Error(typeof body.detail==='string'?body.detail:'本地服务请求失败');return body;
  })().then(data=>reply({ok:true,data})).catch(error=>reply({ok:false,error:error.message}));
  return true;
});
