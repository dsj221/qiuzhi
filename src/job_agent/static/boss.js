(function(){
  'use strict';
  const $=s=>document.querySelector(s);
  const labels={waiting:'等待扩展配对 / 同步',paired:'扩展已配对，待绑定会话',syncing:'会话同步中',revoked:'已撤销'};
  const actionLabels={DRAFT:'待确认',APPROVED:'已确认，等待扩展填入',FILLING:'正在填入，请核对',FILLED:'已填入，待你在平台发送',FAILED:'填入失败',UNKNOWN:'结果待核对',CANCELLED:'已取消',CHECKED:'已人工核对'};
  let data={connections:[],messages:[],actions:[]}, signature='',loading=false;
  const drafts=new Map();
  function modalError(error){const box=$('#boss-modal').open?$('#boss-modal-error'):$('#error');box.textContent=error.message;box.classList.remove('hidden');}
  function renderConnections(){
    const active=data.connections.filter(c=>!c.revoked),syncing=active.filter(c=>c.status==='syncing');
    $('#boss-summary').textContent=syncing.length?`BOSS 会话同步中 · ${syncing.length} 个连接`:active.length?'BOSS 等待页面绑定与同步':'BOSS 尚未连接';
    $('#boss-dot').classList.toggle('connected',syncing.length>0);
    $('#boss-connections').innerHTML=data.connections.map(c=>`<article class="boss-connection"><div class="section-heading"><strong>${esc(c.label)}</strong><span class="badge ${c.status==='syncing'?'green':''}">${labels[c.status]}</span></div><p>${c.last_seen?'最近连接：'+esc(dateTime(c.last_seen)):'尚未收到扩展同步'}</p>${c.session?`<p>${c.capture_mode==='snapshot'?'本次页面会话快照 · 草稿需回扩展逐条确认':'已绑定内部岗位 · 账号 / 招聘方会话已限定'}</p>`:''}${!c.revoked?`<button class="text-button danger" data-boss-revoke="${c.id}">撤销连接</button>`:''}</article>`).join('')||'<p class="notice">还没有配对记录。先加载扩展，再创建配对凭证。</p>';
  }
  function jobPanel(job){
    let node=$('#boss-job-panel');
    if(!job)return;
    if(!node){node=document.createElement('section');node.id='boss-job-panel';node.className='boss-chat';if(job.requirements_need_review)$('#job-detail .detail-top').after(node);else $('#job-detail').append(node);}
    if(node.contains(document.activeElement)&&document.activeElement.matches('input,textarea,select'))return;
    const connections=data.connections.filter(c=>!c.revoked&&c.session?.job_id===job.id);
      const messages=data.messages.filter(m=>m.job_id===job.id&&connections.some(c=>c.id===m.connection_id&&JSON.stringify(c.session.binding)===JSON.stringify(m.binding))).slice(-30);
    const actions=data.actions.filter(a=>a.job_id===job.id).slice(-5).reverse();
    const review=job.requirements_need_review&&(!job.auto_match_state||job.auto_match_state==='waiting_jd'||job.auto_match_state==='failed')?`<details class="boss-review"><summary>手动补充岗位要求（可选）</summary><form id="boss-requirements-form"><p class="field-help">每行填写一项，格式为“要求 | 关键词 | 权重”。</p><label>匹配要求<textarea name="requirements" rows="6" required>${esc(job.requirements.map(r=>r.text+' | '+r.keywords.join(',')+' | '+r.weight).join('\n'))}</textarea></label><button type="submit" class="primary">保存岗位要求</button></form></details>`:'';
    node.innerHTML=`${job.source?`<p class="boss-source">来源：${job.source==='boss'?'BOSS 直聘当前页面':job.source==='boss-chat'?'BOSS 聊天岗位':'本机模拟页面'} · 导入后保留岗位快照</p>`:''}${review}<div class="section-heading"><h3>BOSS 沟通</h3><button class="text-button" data-open-boss-connections>管理连接</button></div>${connections.length?`<p class="field-help">只显示当前绑定会话的消息。${connections.some(c=>c.capture_mode==='snapshot')?'当前为页面快照，每次替换旧快照；草稿需回扩展核对并点击填入。':''}${connections.some(c=>c.status==='syncing')?'扩展正在同步。':'当前离线，请在扩展开始同步。'}</p><div class="boss-message-list">${messages.map(m=>`<article class="boss-message ${m.role==='me'?'mine':''}"><small>${m.role==='me'?'我':'招聘方'}${m.snapshot?' · 当前可见快照':m.baseline?' · 历史基线':''}</small><p>${esc(m.text)}</p></article>`).join('')||'<p class="muted">当前会话暂无可见消息。</p>'}</div><form id="boss-draft-form"><label>填入哪个已绑定连接<select name="connection_id">${connections.map(c=>`<option value="${c.id}">${esc(c.label)} · ${labels[c.status]}</option>`).join('')}</select></label><label>沟通草稿<textarea id="boss-draft-text" name="text" rows="4" required maxlength="3000" placeholder="写下你准备回复招聘方的内容。确认后只填入BOSS输入框。">${esc(drafts.get(job.id)||'')}</textarea></label><div class="actions"><button class="secondary" type="submit">保存待确认草稿</button><button type="button" class="text-button" data-boss-greeting ${job.report?'':'disabled'}>用简历证据生成开场草稿</button></div></form>`:'<div class="notice">在扩展中使用“求职聊天快照配置”，核对并绑定当前会话，可同步可见消息。草稿需先在此确认，再回扩展核对当前会话并点击填入。刷新或切换会话后重新绑定。</div>'}${actions.map(a=>`<article class="boss-action"><span class="badge">${actionLabels[a.state]}</span><p>${esc(a.text)}</p>${a.state==='DRAFT'?`<button class="primary" data-boss-approve="${a.id}">${a.capture_mode==='snapshot'?'确认草稿，再到扩展填入':'确认并填入 BOSS 输入框'}</button>`:''}${['UNKNOWN','FILLING','FILLED'].includes(a.state)?`<button class="secondary" data-boss-resolve="${a.id}">${a.state==='FILLED'?'我已在 BOSS 核对草稿状态':'我已检查 BOSS 输入框，结束此动作'}</button>`:''}</article>`).join('')}<p class="field-help">填入输入框不表示已发送或已投递。聊天草稿请在平台核对后自行发送；已确认投递批次会按明确平台回执同步进度。</p>`;
  }
  window.renderBossPanel=function(job){signature='';jobPanel(job);};
  async function load(){
    if(loading)return;loading=true;
    try{const result=await api('/api/boss'),next=JSON.stringify(result);data=result;renderConnections();
      const editing=document.activeElement?.matches('input,textarea,select');
      if(!editing&&result.job_ids?.some(id=>!state.jobs.some(j=>j.id===id)))await refresh();
      else if(!editing&&state.jobs.some(j=>['pending','waiting_jd'].includes(j.auto_match_state))){
        const latest=await api('/api/overview');
        const changed=latest.jobs.filter(j=>{const previous=state.jobs.find(item=>item.id===j.id);return previous&&(previous.auto_match_state!==j.auto_match_state||previous.report?.created_at!==j.report?.created_at);});
        if(changed.length&&!document.activeElement?.matches('input,textarea,select')){
          state.jobs=latest.jobs;renderList();
          if(changed.some(j=>j.id===selected)){
            const form=$('#tracking-form'),draft=form?new FormData(form):null;
            renderDetail();
            if(draft)for(const [name,value] of draft)$('#tracking-form').elements[name].value=value;
          }
        }
      }
      if(next!==signature){jobPanel(state.jobs.find(j=>j.id===selected));if(!$('#boss-job-panel')?.contains(document.activeElement)||!document.activeElement.matches('input,textarea,select'))signature=next;}}
    finally{loading=false;}
  }
  document.addEventListener('click',event=>{
    const button=event.target.closest('button');if(!button)return;
    if(button.hasAttribute('data-open-boss-connections')){$('#boss-modal-error').classList.add('hidden');$('#boss-modal').showModal();void load().catch(modalError);return;}
    if(button.id==='boss-modal-close'){$('#boss-modal').close();return;}
    if(button.id==='boss-open'){
      if(!$('#jobs-view').classList.contains('hidden')){
        const form=$('#search-preferences-form');
        const link=$('#search-plan-links a');
        if(link&&!form.dataset.edited){link.click();return;}
        if(form.dataset.edited||form.elements.titles.value.trim()){
          form.requestSubmit(form.querySelector('[value="search"]'));return;
        }
      }
      const popup=window.open('https://www.zhipin.com/web/user/','job-agent-boss','popup=yes,width=1180,height=820');
      if(popup){popup.opener=null;$('#boss-window-status').textContent='已请求打开 BOSS 登录窗口；登录后请用 Chrome 扩展配对。';}
      else{$('#boss-window-status').innerHTML='弹窗被拦截，<a href="https://www.zhipin.com/web/user/" target="_blank" rel="noopener noreferrer">点击新标签页打开 BOSS ↗</a>。';}
      return;
    }
    void (async()=>{try{
      if(button.id==='boss-copy-pair'){await navigator.clipboard.writeText($('#boss-pair-value').value);toast('配对凭证已复制，请粘贴到扩展侧栏');}
      if(button.dataset.bossRevoke){await api('/api/boss/connections/'+button.dataset.bossRevoke,'DELETE');await load();toast('连接已撤销');}
      if(button.dataset.bossApprove){button.disabled=true;await api('/api/boss/actions/'+button.dataset.bossApprove+'/approve','POST');await load();toast('草稿已确认；快照模式请在扩展核对并点击填入，发送仍由你完成');}
      if(button.dataset.bossResolve){await api('/api/boss/actions/'+button.dataset.bossResolve+'/resolve','POST');await load();}
      if(button.hasAttribute('data-boss-greeting')){const prep=await api('/api/jobs/'+selected+'/preparation');drafts.set(selected,prep.greeting);$('#boss-draft-text').value=prep.greeting;}
    }catch(error){button.disabled=false;modalError(error);}})();
  });
  document.addEventListener('input',event=>{if(event.target.id==='boss-draft-text')drafts.set(selected,event.target.value);});
  document.addEventListener('submit',event=>{
    if(!['boss-pair-form','boss-draft-form','boss-requirements-form'].includes(event.target.id))return;
    event.preventDefault();const button=event.submitter;button.disabled=true;
    void (async()=>{try{
      const form=Object.fromEntries(new FormData(event.target));
      if(event.target.id==='boss-pair-form'){const pair=await api('/api/boss/connections','POST',form);$('#boss-pair-value').value=JSON.stringify(pair,null,2);$('#boss-pair-result').classList.remove('hidden');await load();}
      if(event.target.id==='boss-draft-form'){await api('/api/boss/connections/'+form.connection_id+'/drafts','POST',{text:form.text});signature='';await load();toast('草稿已保存，请核对后确认填入');}
      if(event.target.id==='boss-requirements-form'){
        const lines=form.requirements.split('\n').map(s=>s.trim()).filter(Boolean);
        if(!lines.length||lines.length>8)throw Error('请填写1至8条要求');
        const requirements=lines.map((line,i)=>{const parts=line.split('|').map(s=>s.trim());const weight=Number(parts[2]);if(parts.length!==3||!Number.isInteger(weight)||weight<1||weight>5)throw Error('每行应为：要求 | 关键词 | 权重1–5');return {id:'R'+(i+1),text:parts[0],keywords:parts[1].split(/[,，、]/).map(k=>k.trim()).filter(Boolean),weight};});
        await api('/api/jobs/'+selected+'/requirements','PUT',{requirements});await refresh();toast('岗位要求已保存');
      }
    }catch(error){modalError(error);}finally{if(button.isConnected)button.disabled=false;}})();
  });
  $('#boss-modal').addEventListener('close',()=>{$('#boss-pair-value').value='';$('#boss-pair-result').classList.add('hidden');});
  setInterval(()=>{if(!document.hidden&&($('#boss-modal').open||view==='jobs'))void load().catch(()=>{});},4000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)void load().catch(()=>{});});
  void load().catch(modalError);
})();
