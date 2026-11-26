'use strict';

window.startReplyMonitor=function(occupied,ownsInbox=()=>false){
  const output=$('#followup-status');
  let busy=false, closing=false, monitoringTab=null;
  const realProfile=fetch(chrome.runtime.getURL('boss-chat-profile.json')).then(r=>r.json());
  $('#followup-diagnose').onclick=async()=>{
    const status=$('#followup-diagnosis');
    try{
      const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
      if(!/^https:\/\/www\.zhipin\.com\/web\/geek\/chat(?:[/?#]|$)/.test(tab?.url||''))throw Error('请先打开 BOSS 真实聊天页的附件选择窗口');
      const p={...await realProfile,...(profile.jobSelector==='#fixture-job'?{}:profile)};
      const {tabId,...verified}=await page('FOLLOW_DIAGNOSE',{profile:p,label:$('#followup-file').value.trim()},tab.id);
      profile={...p,...verified};await chrome.storage.local.set({profile});
      $('#profile').value=JSON.stringify(profile,null,2);
      status.textContent='已识别文件和独立确认按钮，配置已保存。现在可以关闭选择窗口。';
    }catch(e){status.textContent=e.message;}
  };
  function check(){if(closing||occupied())throw Error('页面操作已暂停');}
  const inspect=createReplyScanner({api,page,getProfile:()=>profile,check,
    report:text=>{output.textContent=text;},monitor:id=>{monitoringTab=id;}});
  async function tick(reason,expectedTab){
    if(busy||closing||occupied()||$('#followup-diagnose').closest('details').open)return;
    busy=true;
    try{
      await navigator.locks.request('job-agent-real-automation',{ifAvailable:true},async lock=>{
        if(!lock||occupied())return;
        const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
        if(expectedTab!=null&&tab?.id!==expectedTab)return;
        const fixture=/^http:\/\/127\.0\.0\.1:8766\/boss-fixture(?:[?#]|$)/.test(tab?.url||'');
        if(!fixture&&!/^https:\/\/www\.zhipin\.com\/web\/geek\/chat(?:[/?#]|$)/.test(tab?.url||'')){
          monitoringTab=null;output.textContent='请将已登录的 BOSS 聊天页设为当前标签页。';return;
        }
        await inspect(tab,fixture,reason,ownsInbox(tab.id));
      });
    }catch(e){output.textContent='跟进待核对 · '+e.message;}
    finally{busy=false;}
  }
  chrome.runtime.onMessage.addListener((msg,sender)=>{
    if(msg.type==='FOLLOW_WAKE'&&msg.reason&&sender.id===chrome.runtime.id&&sender.tab?.id)void tick(msg.reason,sender.tab.id);
  });
  $('#followup-catchup').onclick=()=>tick('catch_up');
  const timer=setInterval(tick,5000);
  window.addEventListener('pagehide',()=>{closing=true;clearInterval(timer);});
  return {busy:()=>busy, monitors:tabId=>monitoringTab===tabId};
};
