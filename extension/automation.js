'use strict';

window.startJobAutomation=function(engine){
  const toggle=$('#automatic-enabled'),mode=$('#automatic-mode'),resume=$('#automatic-resume');
  const report=message=>{$('#automation-status').textContent=message;};
  const enabled=()=>!!config&&toggle.checked;
  const official=url=>url?.startsWith('https://www.zhipin.com/');
  const workbench=url=>url?.startsWith('http://127.0.0.1:8766/');
  const reviewURL=id=>'http://127.0.0.1:8766/?review='+encodeURIComponent(id)+'#jobs';
  let config=null,epoch=0,polling=false,lastImport='',nextNetwork=0,closing=false;
  let compatible=false,nextVersionCheck=0;
  const presented=new Set();
  let chatSession=null,unreadable=null,diagnosed='',flowTab=null;
  const chatURL='https://www.zhipin.com/web/geek/chat';
  const step=(id,message)=>{$('#step-'+id).textContent=message;};
  function current(token){if(!enabled()||epoch!==token||closing)throw Error('自动化已暂停');}
  function controls(){
    toggle.checked=!!config;
    mode.disabled=resume.disabled=!!config;
    $('#automatic-resume-field').hidden=mode.value!=='resume';
  }
  async function disable(reason='自动化已关闭'){
    epoch++;config=null;compatible=false;nextVersionCheck=0;lastImport='';chatSession=null;unreadable=null;flowTab=null;presented.clear();controls();
    await Promise.all([engine.halt(),chrome.storage.local.remove('jobAutomation')]);
    report(reason);
  }
  function activeTab(){return chrome.tabs.query({active:true,currentWindow:true}).then(tabs=>tabs[0]);}
  async function assertAccount(tab,token){
    const account=await page('PIPE_ACCOUNT',{},tab.id);
    current(token);
    if(account.account_label!==config.account)throw Error('BOSS 显示账号已改变，请重新开启自动化');
  }
  async function openSearch(settings){
    const first=settings.search_plan.entries[0];
    if(!first||!official(first.url))throw Error('请先在工作台保存目标岗位和意向城市');
    return chrome.tabs.create({url:first.url,active:true});
  }
  async function waitForAccount(id){
    let error;
    const deadline=Date.now()+15000;
    for(let attempt=0;attempt<40&&Date.now()<deadline;attempt++){
      if((await activeTab())?.id!==id)throw Error('页面已切换');
      try{return await page('PIPE_ACCOUNT',{},id);}catch(e){error=e;}
      await new Promise(resolve=>setTimeout(resolve,300));
    }
    throw error;
  }
  mode.onchange=controls;
  toggle.onchange=async()=>{
    if(!toggle.checked){await disable();return;}
    toggle.disabled=true;
    try{
      step('batch','等待本轮筛选');
      step('pair','正在连接本机工作台');
      const pairing=await pairWorkbench();
      await jobs();step('pair','已配对，岗位列表已刷新');
      await configure();
      const settings=await api('SEARCH');

      if(mode.value==='resume'&&(!resume.value.trim()||profile.resumeChooserVerified!==true))throw Error('附件模式需要完整文件名和已验证的 BOSS 简历选择器');
      let tab=await activeTab();
      if(!official(tab?.url))tab=await openSearch(settings);
      const account=await waitForAccount(tab.id);
      flowTab=tab.id;
      stop();bound=null;$('#fill-now').hidden=true;
      config={workflowVersion:2,connection:pairing.connection_id,account:account.account_label,mode:mode.value,
        resume:resume.value.trim(),lastSearch:''};
      await chrome.storage.local.set({jobAutomation:config});
      controls();report('已开启，正在检查当前岗位及搜索条件。');void tick();
    }catch(error){config=null;controls();report(error.message);}
    finally{toggle.disabled=false;}
  };
  async function pairWorkbench(){
    const existing=await api('STATUS');
    if(existing.paired)return existing;
    const url='http://127.0.0.1:8766/';
    const tab=await chrome.tabs.create({url,active:false});
    try{
      for(let i=0;i<60;i++){
        const current=await chrome.tabs.get(tab.id);
        if(current.url===url&&current.status==='complete'){
          // Wait for the listener without repeating a pairing request.
          const probe=await extensionMessage(()=>chrome.tabs.sendMessage(tab.id,{type:'PAIR_READY'},{frameId:0}),
            true,'本机工作台页面');
          if(!probe?.ready)throw Error('工作台配对表单尚未就绪');
          const result=await extensionMessage(()=>chrome.tabs.sendMessage(tab.id,{type:'CREATE_LOCAL_PAIR'},{frameId:0}),
            false,'本机工作台页面');
          if(!result?.value)throw Error(result?.error||'工作台未返回配对凭证');
          const stored=await chrome.runtime.sendMessage({type:'SAVE_PAIR',value:result.value});
          if(!stored?.ok)throw Error(stored?.error||'配对保存失败');
          return await api('STATUS');
        }
        await new Promise(resolve=>setTimeout(resolve,300));
      }
      throw Error('本机工作台尚未就绪');
    }finally{
      const created=await chrome.tabs.get(tab.id).catch(()=>null);
      if(created?.url===url&&!created.active)await chrome.tabs.remove(tab.id);
    }
  }
  async function configure(){
    const defaults=await (await fetch(chrome.runtime.getURL('boss-chat-profile.json'))).json();
    const saved=(await chrome.storage.local.get('profile')).profile||{};
    profile=saved.jobSelector==='#fixture-job'?defaults:{...defaults,...saved,captureMode:'snapshot'};
    $('#profile').value=JSON.stringify(profile,null,2);
    await chrome.storage.local.set({profile});
    step('profile','已载入 BOSS 岗位、详情和聊天配置');
  }
  function labelMatch(labels,context){
    return labels?.account===config.account&&labels.conversation===context.contact&&
      labels.position.split('\n')[0].trim().replace(/[（(]猎头职位[）)]$/,'').trim()===context.title;
  }
  async function saveJob(job,verifiedLabels,token){
    current(token);
    const data=await api('JOBS');
    const prior=data.jobs.find(item=>item.id===data.bound_job_id);
    const usePrior=verifiedLabels&&prior?.needs_jd&&prior.title===job.title&&prior.company===job.company&&
      !data.jobs.some(item=>item.external_id===job.external_id)&&
      ['account','conversation','position'].every(k=>verifiedLabels[k]===data.labels?.[k]);
    current(token);
    let id;
    if(usePrior){
      await api('UPDATE_JOB_JD',{...job,confirmed:true,verified_chat:verifiedLabels},prior.id);
      id=prior.id;
    }else{
      const imported=await api('IMPORT_JOB',{...job,confirmed:true});
      id=imported.job_id;
      if(imported.existing&&verifiedLabels)await api('UPDATE_JOB_JD',{...job,confirmed:true},id);
    }
    await jobs(id);
    $('#job-diagnosis').textContent=JSON.stringify(job,null,2);
    $('#jd-status').textContent='已读取完整 JD，共 '+job.description.length+' 字。';
    const message=job.company+' · '+job.title;
    importStatus('已关联工作台岗位：'+message);
    step('job',message+'，JD '+job.description.length+' 字');
    return id;
  }
  async function syncChat(tab,context,token,expectedJob=null){
    let snap=await page('READ_CHAT',{},tab.id);
    current(token);
    if(!labelMatch(snap.labels,context))throw Error('会话标签已变化');
    const reusable=chatSession&&chatSession.tab===tab.id&&snap.binding&&
      JSON.stringify(snap.binding)===JSON.stringify(chatSession.binding);
    if(!reusable){
      let detailTab;
      const job=await readImportJob(context,id=>{detailTab=id;});
      current(token);
      if(expectedJob&&expectedJob.external_id!==job.external_id)throw Error('聊天中的官方岗位 ID 与详情不一致');
      if((await activeTab())?.id!==detailTab)throw Error('当前标签页已变化');
      await assertAccount({id:detailTab},token);
      await chrome.tabs.update(tab.id,{active:true});
      const detail=await chrome.tabs.get(detailTab);
      if(!detail.active&&official(detail.url)&&new URL(detail.url).pathname===new URL(job.url).pathname)await chrome.tabs.remove(detailTab);
      const again=await page('BIND_CHAT',{},tab.id);
      current(token);
      if(!labelMatch(again.labels,context)||JSON.stringify(again.labels)!==JSON.stringify(snap.labels))throw Error('读取岗位期间会话已切换');
      const id=await saveJob(job,again.labels,token);
      chatSession={tab:tab.id,jobId:id,binding:again.binding,baseline:true};
      snap=again;
    }
    current(token);
    const session=chatSession;
    await api('OBSERVE',{job_id:session.jobId,binding:snap.binding,messages:snap.messages,
      capture_mode:snap.capture_mode,labels:snap.labels,baseline:session.baseline,confirmed:session.baseline});
    session.baseline=false;
    $('#chat-diagnosis').textContent=JSON.stringify({labels:snap.labels,visible_messages:snap.messages.length},null,2);
    step('chat','已绑定 '+context.contact.split('\n')[0]+'，已同步 '+snap.messages.length+' 条可见消息');
    await engine.syncReceipts();
  }
  async function importVisible(tab,token){
    const path=new URL(tab.url).pathname;
    if(!/^\/job_detail\/[\w-]+\.html$/.test(path)&&!['/web/geek/jobs','/web/geek/chat'].includes(path))return;
    const context=await page('JOB_IMPORT_CONTEXT',{},tab.id);
    current(token);
    if(context.kind==='chat'){
      if(context.drafting){step('chat','已有手写草稿，等待处理');return 'draft';}
      await syncChat(tab,context,token);return;
    }
    const job=context.job;
    if(lastImport===job.external_id)return;
    if(context.existingChat){
      // Read the existing conversation list without touching a contact/send button.
      const chatTab=await chrome.tabs.create({url:'https://www.zhipin.com/web/geek/chat'});
      await waitForAccount(chatTab.id);await assertAccount(chatTab,token);
      const action={...job,account_label:config.account,expires_at:Date.now()/1000+45};
      let error;
      for(let i=0;i<16;i++){
        current(token);
        try{
          await page('PIPE_SELECT_CHAT',{action},chatTab.id);
          await page('PIPE_TARGET',{action},chatTab.id);
          error=null;break;
        }catch(e){error=e;if(/账号|后台|草稿|多个联系人|标签页已变化/.test(e.message))break;}
        await new Promise(resolve=>setTimeout(resolve,300));
      }
      if(!error){
        const actual=await page('JOB_IMPORT_CONTEXT',{},chatTab.id);
        await syncChat(chatTab,actual,token,job);
      }else{
        step('chat','本岗位暂缓同步：'+error.message);
        current(token);
        if((await activeTab())?.id===chatTab.id)await chrome.tabs.update(tab.id,{active:true});
        await saveJob(job,null,token);
      }
    }else{
      await saveJob(job,null,token);
      step('chat','当前岗位未显示已有会话，继续筛选');
    }
    lastImport=job.external_id;
  }
  async function run(tab,settings,key,token){
    const success=await engine.begin(async operation=>{
      flowTab=tab.id;
      const progress=message=>{current(token);step('batch',message);report(message);engine.status(message);};
      progress('正在准备本轮岗位筛选');
      const {counts}=await engine.search(operation,settings,tab.id,config.account,progress);
      current(token);engine.check(operation);
      const result=await api('AUTO_DRAFTS',{opportunity_ids:counts.ids,preferences_revision:settings.preferences.revision,
        resume_revision:settings.resume_revision,account_label:config.account,mode:config.mode,resume_label:config.mode==='resume'?config.resume:''});
      current(token);
      config.lastSearch=key;await chrome.storage.local.set({jobAutomation:config});
      const message='搜索完成，读取 '+counts.read+' 个岗位，符合 '+counts.matched+' 个，待核对 '+counts.review+' 个，生成 '+result.batches.length+(result.auto_greeting?' 个自动招呼批次。':' 个待确认批次。');
      step('batch',message);report(message);engine.status(message);
      try{lastImport=(await page('PIPE_CURRENT',{},tab.id)).job.external_id;}catch{}
    },{resumeSearch:true});
    if(success===false&&enabled()){
      const message=$('#pipeline-status').textContent;
      step('batch',message);
      await disable('自动搜索暂停。'+message);
    }
  }
  async function inspect(token){
    if(engine.occupied()||!enabled())return;
    const win=await chrome.windows.getCurrent();
    if(!win.focused)return;
    let tab=await activeTab();if(tab?.status!=='complete')return;
    if(!official(tab.url)&&!workbench(tab.url))return;
    const now=Date.now();
    const pairing=await api('STATUS');current(token);
    if(pairing.connection_id!==config.connection)throw Error('配对连接已改变，请重新开启自动化');
    if(!compatible){
      if(now<nextVersionCheck)return;
      nextVersionCheck=now+5000;
      let capabilities;
      try{capabilities=await api('FOLLOW_TARGETS');}
      catch(error){
        if(!/Failed to fetch|NetworkError|未收到本机工作台响应/i.test(error.message))throw error;
        report('等待本机工作台重新上线，连接恢复后自动继续。');return;
      }
      current(token);
      if(!Array.isArray(capabilities.threads)){
        report('等待工作台升级至 0.10.0，升级完成后会自动开始。');return;
      }
      compatible=true;
      report('工作台已连接，全流程已启动。');
    }
    const route=new URL(tab.url);
    if(official(tab.url)){
      await assertAccount(tab,token);
      if(flowTab===null&&['/web/geek/jobs','/web/geek/chat'].includes(route.pathname))flowTab=tab.id;
      const locationKey=tab.id+':'+route.pathname;
      if(diagnosed!==locationKey){
        const structure=await page('INSPECT',{},tab.id);current(token);
        $('#page-structure').value=JSON.stringify(structure,null,2);
        step('profile','已诊断 '+structure.path.split('/').slice(0,3).join('/'));
        diagnosed=locationKey;
      }
      if(route.pathname==='/web/geek/chat'){
        const ready=await page('FOLLOW_NAV_READY',{},tab.id);
        if(!ready.ready){step('chat',ready.reason);return;}
      }
      const managed=tab.id===flowTab&&(route.pathname==='/web/geek/chat'||!!config.lastSearch&&route.pathname==='/web/geek/jobs');
      if(!managed&&!(route.pathname==='/web/geek/chat'&&engine.monitoringChat?.(tab.id))&&(!unreadable||unreadable.key!==locationKey||now>=unreadable.until)){
        try{
          if(await importVisible(tab,token)==='draft')return;
          unreadable=null;
        }catch(error){
          current(token);
          if(/账号|后台|标签页已变化|配对已失效|安全验证|登录或验证/.test(error.message))throw error;
          const message='本页暂缓：'+error.message;
          importStatus(message,true);step(route.pathname==='/web/geek/chat'?'chat':'job',message);
          unreadable={key:locationKey,until:now+30000};
        }
      }
      if(tab.id!==(await activeTab())?.id)return;
    }
    if(now<nextNetwork)return;
    nextNetwork=now+4000;
    const pending=await api('APPLICATIONS');current(token);
    const approved=pending.batches.find(batch=>batch.automatic&&batch.state==='APPROVED'&&!batch.dispatched_at&&batch.account_label===config.account);
    if(approved&&(official(tab.url)||workbench(tab.url))){
      if(!official(tab.url)){
        // Use a fresh operation tab; the workbench and the user's other tabs stay available.
        const item=pending.items.find(i=>i.batch_id===approved.id);
        if(!official(item?.search_url))throw Error('批次缺少真实 BOSS 搜索来源');
        tab=await chrome.tabs.create({url:item.search_url});await waitForAccount(tab.id);
      }
      await assertAccount(tab,token);current(token);
      const ok=await engine.begin(async op=>{
        current(token);flowTab=tab.id;
        await api('APP_DISPATCH',{},approved.id);current(token);
        await engine.executeBatch(op,approved.id);
      });
      if(enabled()){report($('#pipeline-status').textContent);step('batch',$('#pipeline-status').textContent);}
      if(ok===false&&enabled())await disable('批次执行暂停。'+$('#pipeline-status').textContent);
      return;
    }
    const draft=pending.drafts?.find(b=>b.account_label===config.account&&!presented.has(b.id));
    if(draft){
      if(workbench(tab.url)&&route.searchParams.get('review')&&pending.drafts.some(b=>b.id===route.searchParams.get('review'))){
        presented.add(route.searchParams.get('review'));return;
      }
      current(token);
      await chrome.tabs.create({url:reviewURL(draft.id)});presented.add(draft.id);
      step('batch','等待整批确认，确认后自动执行');report('批次已准备，等待你在工作台核对并确认。');return;
    }
    if(workbench(tab.url)&&route.searchParams.has('review'))return;
    const settings=await api('SEARCH');current(token);
    if(!settings.resume_revision||!settings.search_plan.entries.length){step('batch',settings.search_plan.warnings?.join('。')||'等待工作台保存简历和筛选条件');return;}
    if(settings.model_enabled===false){step('batch','等待在工作台设置匹配 API Key');return;}
    const key=[settings.matching_version||'',new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'}),settings.preferences.revision,settings.resume_revision].join('/');
    if(config.lastSearch!==key){
      if(!official(tab.url)||route.pathname!=='/web/geek/jobs'){
        step('batch','正在打开真实岗位搜索');
        tab=await openSearch(settings);await waitForAccount(tab.id);
      }
      current(token);if(engine.occupied())return;
      await run(tab,settings,key,token);
    }else if(tab.id===flowTab&&official(tab.url)){
      const follow=await api('FOLLOW_TARGETS');current(token);
      if(!follow.enabled||follow.account_label!==config.account){
        step('chat','请在工作台为当前账号开启 HR 回复跟进');return;
      }
      if(route.pathname==='/web/geek/jobs'||route.pathname.startsWith('/job_detail/')){
        if((await activeTab())?.id!==tab.id)return;
        await chrome.tabs.update(tab.id,{url:chatURL});
      }
      if(route.pathname==='/web/geek/chat'||route.pathname==='/web/geek/jobs'||route.pathname.startsWith('/job_detail/')){
        step('chat','正在监听 HR 新来信，收到后会切换会话并按跟进设置回复');
        step('batch','本轮筛选完成；下次条件更新或次日继续搜索');
      }
    }
  }
  async function tick(){
    if(polling||!enabled()||closing)return;
    polling=true;const token=epoch;
    try{await navigator.locks.request('job-agent-real-automation',{ifAvailable:true},async lock=>{if(lock)await inspect(token);});}
    catch(error){
      if(token===epoch&&enabled()){
        if(error.name==='ReadReceiverUnavailable')report(error.message+' 正在等待重连。');
        else await disable('自动化暂停：'+error.message);
      }
    }
    finally{polling=false;}
  }
  const timer=setInterval(()=>void tick(),2000);
  window.addEventListener('pagehide',()=>{closing=true;epoch++;clearInterval(timer);});
  chrome.storage.onChanged.addListener((changes,area)=>{
    if(area!=='local'||!changes.jobAutomation)return;
    const next=changes.jobAutomation.newValue?.workflowVersion===2?changes.jobAutomation.newValue:null;
    if(config&&!next){epoch++;void engine.halt();report('自动化已关闭');}
    config=next;
    if(config){mode.value=config.mode;resume.value=config.resume;}
    controls();
  });
  chrome.storage.local.get('jobAutomation').then(saved=>{
    config=saved.jobAutomation?.workflowVersion===2?saved.jobAutomation:null;
    if(config){step('pair','使用已保存的配对');step('profile','使用已保存的真实页面配置');mode.value=config.mode;resume.value=config.resume;report('自动化已开启，等待真实 BOSS 页面或本机工作台。');}
    controls();
  }).catch(error=>report(error.message));
  return {enabled,disable,ownsInbox:id=>enabled()&&compatible&&flowTab===id};
};
