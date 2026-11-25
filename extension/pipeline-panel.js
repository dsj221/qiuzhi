(function(){
  'use strict';
  const q=s=>document.querySelector(s);
  let busy=false,generation=0,operationTab=null,currentBatch=null,operationProfile='',receiptTimer=null,receiptBusy=false;
  const say=text=>{q('#pipeline-status').textContent=text;};
  const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  function check(epoch){if(epoch!==generation)throw Error('任务已停止');if(JSON.stringify(profile)!==operationProfile)throw Error('页面适配配置已变化，任务已停止');}
  async function pipe(type,extra={},epoch=generation){check(epoch);return page(type,extra,operationTab);}
  async function until(read,epoch,tries=20){let last;for(let i=0;i<tries;i++){check(epoch);try{return await read();}catch(error){last=error;if(/登录|验证|账号|后台|当前标签页已变化/.test(error.message))throw error;}await sleep(300);}throw last||Error('页面未就绪');}
  async function select(key,epoch){await pipe('PIPE_SELECT',{external_id:key},epoch);return until(async()=>{const current=await pipe('PIPE_CURRENT',{},epoch);if(current.job.external_id!==key)throw Error('岗位详情正在切换');return current;},epoch);}
  function listUrl(value){const url=new URL(value);if(url.username||url.password||url.hash||!(url.origin==='https://www.zhipin.com'&&url.pathname==='/web/geek/jobs'||url.origin==='http://127.0.0.1:8766'&&url.pathname==='/boss-fixture'))throw Error('搜索来源不是受支持的官方岗位列表');return url.href;}
  async function navigate(value,epoch){
    const url=listUrl(value);check(epoch);
    const [active]=await chrome.tabs.query({active:true,currentWindow:true});if(active?.id!==operationTab)throw Error('当前标签页已变化，任务已停止');
    await chrome.tabs.update(operationTab,{url});
    return until(async()=>{const tab=await chrome.tabs.get(operationTab);if(tab.status!=='complete')throw Error('搜索页面正在加载');if(tab.url!==url)throw Error('搜索地址已变化，请核对页面');const listing=await pipe('PIPE_LIST',{},epoch);if(listing.list_url!==url)throw Error('搜索页面尚未切换完成');return listing;},epoch,60);
  }
  async function chat(action,epoch,url='https://www.zhipin.com/web/geek/chat'){
    check(epoch);const target=new URL(url);
    if(target.origin!=='https://www.zhipin.com'||target.pathname!=='/web/geek/chat'||target.username||target.password)throw Error('聊天地址不是BOSS官方会话页');
    const current=await chrome.tabs.get(operationTab);
    if(new URL(current.url).pathname!=='/web/geek/chat'){
      await chrome.tabs.update(operationTab,{url:target.href});
      await until(async()=>{const tab=await chrome.tabs.get(operationTab);if(tab.status!=='complete'||new URL(tab.url).pathname!=='/web/geek/chat')throw Error('正在进入BOSS聊天页');return pipe('PIPE_ACCOUNT',{},epoch);},epoch,60);
    }
    await until(()=>pipe('PIPE_SELECT_CHAT',{action},epoch),epoch,60);
    return until(()=>pipe('PIPE_TARGET',{action},epoch),epoch,60);
  }
  async function collectListing(listing,settings,epoch,seen,counts){
    for(const candidate of listing.jobs.slice(0,settings.preferences.limit)){
      check(epoch);if(seen.has(candidate.external_id))continue;
      say(`正在读取第 ${counts.read+1} 个岗位：${candidate.title}`);
      const current=await select(candidate.external_id,epoch);if(current.account_label!==listing.account_label)throw Error('显示账号已变化');check(epoch);
      const result=await api('COLLECT',{jobs:[current.job],search_url:listing.list_url,preferences_revision:settings.preferences.revision});
      seen.add(candidate.external_id);counts.read++;const status=result.opportunities[0].screening.result;counts.matched+=status==='matched'?1:0;counts.review+=status==='review'?1:0;
      if(status==='matched')counts.ids?.push(result.opportunities[0].id);
    }
  }
  async function refreshBatches(){const data=await api('APPLICATIONS');q('#application-batch').replaceChildren(new Option('选择已确认批次',''),...data.batches.map(b=>new Option(`${b.id.slice(0,8)} · ${b.mode==='resume'?'发送指定简历':'打招呼'} · ${data.items.filter(i=>i.batch_id===b.id).length} 个待处理`,b.id)));return data;}
  async function begin(work){if(busy)return;busy=true;stop();bound=null;operationProfile=JSON.stringify(profile);q('#fill-now').hidden=true;const epoch=++generation;for(const id of ['collect-jobs','search-jobs','run-applications'])q('#'+id).disabled=true;try{await work(epoch);return true;}catch(error){say('已停止：'+error.message);return false;}finally{busy=false;operationTab=null;currentBatch=null;for(const id of ['collect-jobs','search-jobs','run-applications'])q('#'+id).disabled=false;}}
  async function search(epoch,settings,expectedTab=null,expectedAccount=null){
    const plan=settings.search_plan;if(!plan?.entries.length)throw Error('请先在工作台保存筛选条件');
    const context=await pipe('PIPE_ACCOUNT',{},epoch);operationTab=context.tabId;if((expectedTab!==null&&expectedTab!==operationTab)||(expectedAccount&&expectedAccount!==context.account_label))throw Error('自动搜索的账号或标签页已变化');if(profile.jobSelector==='#fixture-job')throw Error('模拟配置仅支持采集模拟列表；搜索真实岗位前请使用已验证的岗位列表配置');
    const counts={read:0,matched:0,review:0,ids:[]},seen=new Set();
    for(let i=0;i<plan.entries.length;i++){
      const entry=plan.entries[i];check(epoch);say(`正在搜索 ${i+1}/${plan.entries.length}：${entry.title} · ${entry.city}`);
      if(i>0&&(await api('SEARCH')).preferences.revision!==settings.preferences.revision)throw Error('筛选条件已更新，请重新启动搜索');check(epoch);
      const listing=await navigate(entry.url,epoch);if(listing.account_label!==context.account_label)throw Error('显示账号已变化');
      await collectListing(listing,settings,epoch,seen,counts);
    }
    await jobs();return {counts,plan,context};
  }
  q('#search-jobs').onclick=()=>begin(async epoch=>{
    const {counts,plan}=await search(epoch,await api('SEARCH'));
    say(`搜索完成：${plan.entries.length}/${plan.total} 组条件，去重读取 ${counts.read} 个岗位，${counts.matched} 个符合，${counts.review} 个待核对。回工作台勾选符合项并预览投递批次。`);
  });
  q('#collect-jobs').onclick=()=>begin(async epoch=>{
    const settings=await api('SEARCH');if(!settings.preferences.revision)throw Error('请先在工作台保存筛选条件');
    const listing=await pipe('PIPE_LIST',{},epoch);operationTab=listing.tabId;const counts={read:0,matched:0,review:0};
    await collectListing(listing,settings,epoch,new Set(),counts);
    say(`本页处理完成：${counts.read} 个岗位，${counts.matched} 个符合条件，${counts.review} 个待核对；符合项按工作台设置自动收藏。`);await jobs();
  });
  q('#refresh-batches').onclick=()=>refreshBatches().then(()=>say('已刷新，请核对批次后执行')).catch(error=>say(error.message));
  async function executeBatch(epoch,batchId){
    if(!batchId)throw Error('请选择已确认批次');
    const pending=await api('APPLICATIONS'),batch=pending.batches.find(b=>b.id===batchId);if(!batch)throw Error('批次已暂停或过期，请回工作台核对');
    if(batch.mode==='resume'&&profile.resumeChooserVerified!==true)throw Error('当前页面的附件简历选择器尚未完成现场诊断，暂不执行文件发送；批次保留为待处理。');
    currentBatch=batchId;const context=await pipe('PIPE_ACCOUNT',{},epoch);operationTab=context.tabId;if(context.account_label!==batch.account_label)throw Error('当前显示账号与批次不一致');
    const targets=pending.items.filter(i=>i.batch_id===batchId);
    const fallback=targets.some(i=>!i.search_url)?(await pipe('PIPE_LIST',{},epoch)).list_url:'';
    for(let i=0;i<targets.length;i++){
      let action=null,sideEffectPossible=false;
      try{
        check(epoch);say(`正在核对第 ${i+1}/${targets.length} 个目标：${targets[i].company} · ${targets[i].title}`);
        const listing=await navigate(targets[i].search_url||fallback,epoch);if(listing.account_label!==batch.account_label)throw Error('当前显示账号与批次不一致');
        const current=await select(targets[i].external_id,epoch);
        action=(await api('APP_CLAIM',{batch_id:batchId,job:current.job,account_label:current.account_label})).action;
        const before=await api('APP_PREFLIGHT',{lease:action.lease,stage:'open_chat',account_label:current.account_label,target_verified:true,message_ids:[]},action.id);
        if(!before.allowed)throw Error('发送前核对未通过');check(epoch);
        sideEffectPossible=true;
        const opened=await pipe('PIPE_OPEN',{action},epoch);
        if(opened.already){await api('APP_RESULT',{lease:action.lease,outcome:'ALREADY_CONTACTED',evidence:opened.evidence,reason:'平台显示已有沟通，不重复投递'},action.id);action=null;continue;}
        const target=opened.chat_url?.startsWith('https://www.zhipin.com/web/geek/chat')?await chat(action,epoch,opened.chat_url):await until(()=>pipe('PIPE_TARGET',{action},epoch),epoch);
        if(action.mode==='greeting'&&target.outgoing?.length){
          const existing=target.outgoing[target.outgoing.length-1];
          await api('APP_RESULT',{lease:action.lease,outcome:'ALREADY_CONTACTED',receipt_key:existing.id,evidence:existing.text,reason:'已核对平台会话中的已发送招呼，未追加发送模板'},action.id);action=null;continue;
        }
        let prepared;
        if(action.mode==='greeting')prepared=await pipe('PIPE_PREPARE_GREETING',{action},epoch);
        else{check(epoch);await pipe('PIPE_OPEN_RESUME',{action},epoch);prepared=await until(()=>pipe('PIPE_PREPARE_RESUME',{action},epoch),epoch);}
        await api('APP_PREFLIGHT',{lease:action.lease,stage:action.mode==='greeting'?'send_greeting':'send_resume',account_label:target.account_label,target_verified:true,message_ids:prepared.message_ids,resume_label:prepared.resume_label||''},action.id);
        check(epoch);await pipe(action.mode==='greeting'?'PIPE_SEND_GREETING':'PIPE_SEND_RESUME',{action},epoch);
        let receipt={outcome:'UNKNOWN'};
        for(let t=0;t<20;t++){check(epoch);await sleep(500);receipt=await pipe('PIPE_VERIFY',{action,baseline:prepared.message_ids},epoch);if(receipt.outcome!=='UNKNOWN')break;}
        const result=await api('APP_RESULT',{lease:action.lease,...receipt,reason:receipt.outcome==='UNKNOWN'?'未取得可核对的新回执，停止且不自动重试':''},action.id);action=null;
        if(result.batch_state==='NEEDS_REVIEW')throw Error('平台结果需要人工核对，剩余目标未继续执行');
      }catch(error){
        if(action){try{await api('APP_RESULT',{lease:action.lease,outcome:sideEffectPossible?'UNKNOWN':'FAILED',reason:error.message},action.id);}catch{}}
        throw error;
      }
    }
    say('批次处理结束。请回工作台查看各岗位回执；只有指定简历明确已发送才记为已投递。');await refreshBatches();startReceiptSync();
  }
  q('#run-applications').onclick=()=>begin(epoch=>executeBatch(epoch,q('#application-batch').value));
  async function syncReceipts(){
    if(busy||receiptBusy)return;receiptBusy=true;
    try{const pending=await api('APP_RECEIPTS');let count=0;
      for(const action of pending.items){let receipt;
        try{receipt=await page('PIPE_SYNC_VERIFY',{action});}catch{continue;}
        if(receipt.outcome!=='UNKNOWN'){await api('APP_SYNC',{...receipt,account_label:action.account_label,target_verified:true},action.id);count++;}
      }
      if(count)say('已核对当前会话并同步 '+count+' 项平台回执，没有执行新发送。');
    }catch(error){say('回执同步暂停：'+error.message);clearInterval(receiptTimer);receiptTimer=null;}
    finally{receiptBusy=false;}
  }
  function startReceiptSync(){if(!receiptTimer)receiptTimer=setInterval(()=>void syncReceipts(),5000);}
  q('#sync-application-receipts').onclick=()=>{startReceiptSync();say('每5秒核对当前会话的已确认投递回执；切换到对应会话后自动同步。');return syncReceipts();};
  q('#locate-application-chat').onclick=()=>begin(async epoch=>{
    const selected=q('#job').value;if(!selected)throw Error('请在第①项选择需要核对的内部岗位');
    const data=await api('JOBS'),job=data.jobs.find(item=>item.id===selected);if(!job)throw Error('岗位已变化，请刷新岗位列表');
    const context=await pipe('PIPE_ACCOUNT',{},epoch);operationTab=context.tabId;
    const action={...job,account_label:context.account_label,expires_at:Date.now()/1000+120};
    const target=await chat(action,epoch);say(`已核对真实会话：${job.company} · ${job.title}；${target.outgoing.length} 条本人已发送记录。没有填写或发送新消息。`);
    await syncReceiptsAfterLocate();
  });
  async function syncReceiptsAfterLocate(){
    const pending=await api('APP_RECEIPTS');for(const action of pending.items){
      let receipt;try{receipt=await page('PIPE_SYNC_VERIFY',{action},operationTab);}catch{continue;}
      if(receipt.outcome!=='UNKNOWN')await api('APP_SYNC',{...receipt,account_label:action.account_label,target_verified:true},action.id);
    }
  }
  async function halt(){generation++;clearInterval(receiptTimer);receiptTimer=null;if(operationTab)void chrome.tabs.sendMessage(operationTab,{type:'PIPE_CANCEL',profile}).catch(()=>{});if(currentBatch){try{await api('APP_STOP',{},currentBatch);}catch{}}say('已停止。可能已点击的动作需核对平台，不自动重试。');}
  const automation=window.startJobAutomation?.({
    search,executeBatch,begin,halt,check,syncReceipts,
    occupied:()=>busy||importBusy||jdBusy||!!bound||running,
    status:say
  });
  q('#stop-pipeline').onclick=()=>automation?.enabled()?automation.disable():halt();
  chrome.tabs.onActivated.addListener(({tabId})=>{if(busy&&operationTab&&operationTab!==tabId)void halt();});
  window.addEventListener('pagehide',()=>{generation++;clearInterval(receiptTimer);});
})();
