(function(){
  'use strict';
  const q=s=>document.querySelector(s),picked=new Set();
  const resultLabels={matched:'达到筛选条件',review:'待核对',excluded:'已排除'};
  const batchLabels={DRAFT:'待核对确认',APPROVED:'已确认，待扩展执行',RUNNING:'执行中',NEEDS_REVIEW:'已暂停，需核对',CANCELLED:'已取消',DONE:'处理结束',EXPIRED:'已过期'};
  const outcomeLabels={DRAFT:'待确认',PENDING:'排队中',RUNNING:'执行中',COMMUNICATING:'招呼已核对，沟通中',RESUME_REQUESTED:'已请求发送简历，等待平台处理',RESUME_SENT:'指定简历已发送',ALREADY_CONTACTED:'已核对平台已有沟通，未追加发送',NEEDS_USER:'需要人工处理',UNKNOWN:'结果不明，未重试',FAILED:'未完成',CANCELLED:'已取消'};
  let data=null,deliveries={batches:[],items:[]},connections=[],filter='all',initialized=false,loading=false,working=false,review=null,connectionSignature='',overviewSignature='';
  const list=value=>value.split(/[,，、\n]/).map(s=>s.trim()).filter(Boolean);
  function error(err){const el=q('#application-review').open?q('#application-review-error'):q('#error');el.textContent=err.message;el.classList.remove('hidden');}
  async function act(work){if(working)return;working=true;q('#application-review-error').classList.add('hidden');try{await work();}catch(err){error(err);}finally{working=false;}}
  function initialize(){
    if(initialized)return;const form=q('#search-preferences-form'),prefs=data.preferences;
    for(const name of ['titles','cities','required_keywords','excluded_companies'])form.elements[name].value=prefs[name].join(',');
    for(const name of ['min_salary_k','limit','search_limit','min_score'])form.elements[name].value=prefs[name]??'';
    form.elements.min_coverage.value=Math.round(prefs.min_coverage*100);
    for(const name of ['accept_internship','accept_other_cities','auto_favorite'])form.elements[name].checked=prefs[name];
    q('#preferences-status').textContent=prefs.revision?'已保存条件版本 '+prefs.revision:'先保存筛选条件，再到BOSS扩展搜索并筛选';
    initialized=true;
  }
  function updateConnections(){
    const signature=JSON.stringify(connections.map(c=>[c.id,c.label,c.revoked]));if(signature===connectionSignature)return;
    const select=q('#application-connection'),old=select.value;select.replaceChildren(new Option('选择已配对连接',''),...connections.filter(c=>!c.revoked).map(c=>new Option(c.label+' · 连接 '+c.id.slice(0,8),c.id)));
    if([...select.options].some(o=>o.value===old)&&old)select.value=old;
    else if(select.options.length===2)select.selectedIndex=1;
    if(select.value&&!q('#application-batch-form').elements.account_label.value){const c=connections.find(c=>c.id===select.value);q('#application-batch-form').elements.account_label.value=c?.labels?.account||'';}
    connectionSignature=signature;
  }
  function pickedConnection(){
    const ids=new Set([...picked].map(id=>data.opportunities.find(v=>v.id===id)?.connection_id).filter(Boolean));
    if(ids.size!==1)throw Error('所选岗位来自多个连接，请按采集连接分批勾选');
    const id=[...ids][0],connection=connections.find(c=>c.id===id&&!c.revoked);
    if(!connection)throw Error('所选岗位的采集连接已失效，请使用当前扩展重新采集');
    return connection;
  }
  function alignConnection(){
    if(!picked.size)return;
    try{const c=pickedConnection();q('#application-connection').value=c.id;
      const field=q('#application-batch-form').elements.account_label;if(!field.value)field.value=c.labels?.account||'';
    }catch{}
  }
  function render(){
    if(!data)return;initialize();updateConnections();
    const plan=data.search_plan;
    q('#search-plan-status').textContent=plan?.entries.length?`条件版本 ${data.preferences.revision} · 本次搜索 ${plan.entries.length}/${plan.total} 组 · 每组最多 ${plan.per_search_limit} 个岗位。`+(plan.total>plan.entries.length?' 可提高“每次最多搜索组合数”以搜索更多组合。':'')+(plan.warnings.length?' '+plan.warnings.join('；'):''):'保存目标岗位与城市后，生成搜索计划。';
    q('#search-plan-links').innerHTML=(plan?.entries||[]).map(e=>`<a href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">${esc(e.title)} · ${esc(e.city)} ↗</a>`).join('');
    q('#opportunity-resume-status').textContent=!data.has_resume?'请先在“我的简历”保存本人简历。':data.demo_resume?'当前仍是演示简历，可以体验筛选，但不会允许真实投递。':'使用当前已保存简历进行证据匹配；修改简历或筛选条件后，需要重新采集匹配。';
    const values=data.opportunities;
    q('#opportunity-stats').innerHTML=['matched','review','excluded'].map(k=>`<span>${resultLabels[k]}：<strong>${values.filter(v=>v.screening.result===k&&!v.stale).length}</strong></span>`).join('');
    for(const id of picked){if(!values.some(v=>v.id===id&&!v.stale&&v.screening.result==='matched'))picked.delete(id);}
    alignConnection();
    const visible=values.filter(v=>filter==='all'||v.screening.result===filter);
    q('#opportunity-results').innerHTML=visible.map(v=>{
      const screen=v.screening,report=screen.report,eligible=!v.stale&&screen.result==='matched';
      return `<article class="opportunity-card"><header><label class="pick"><input type="checkbox" data-pick-opportunity="${v.id}" ${eligible?'':'disabled'} ${picked.has(v.id)?'checked':''} aria-label="选择${esc(v.title)} ${esc(v.company)}"><h3>${esc(v.title)}</h3></label><span class="badge ${eligible?'green':screen.result==='review'?'amber':''}">${v.stale?'匹配已过期':resultLabels[screen.result]}</span></header><p>${esc(v.company)} · ${esc(v.city||'城市待核验')}</p><p>${esc(v.salary_text||'薪资待核验')}${v.salary_min_k!=null?' · 月薪区间下限 '+v.salary_min_k+'K':''}</p><p>${report?'证据参考分 '+(report.score??'—')+' · 覆盖 '+Math.round(report.coverage*100)+'%':'尚未形成证据报告'}</p><ul>${[...screen.reasons,...screen.excluded_reasons,...screen.review_reasons].map(s=>`<li>${esc(s)}</li>`).join('')}</ul><div class="actions"><a href="${esc(v.url)}" target="_blank" rel="noopener noreferrer">查看原岗位 ↗</a>${v.favorite_id?'<span class="badge green">已加入收藏机会</span>':`<button class="secondary" data-favorite-opportunity="${v.id}">加入收藏机会</button>`}</div><p class="opportunity-source">${v.source==='fixture'?'本机演示岗位':'BOSS当前列表'} · ${v.screening.requirements.length}项原文技能参考</p></article>`;
    }).join('')||'<p class="batch-empty">尚无筛选结果。保存条件后，在BOSS扩展点击“按已保存条件搜索并筛选”。</p>';
    q('#application-batches').innerHTML=deliveries.batches.map(b=>{
      const items=deliveries.items.filter(i=>i.batch_id===b.id);
      return `<article class="batch-record"><div class="section-heading"><strong>批次 ${b.id.slice(0,8)}</strong><span class="badge">${batchLabels[b.state]}</span></div><p>${items.length} 个具体目标 · ${b.mode==='resume'?'指定简历：'+esc(b.resume_label):'发送招呼，仅记沟通中'} · 账号 ${esc(b.account_label)}</p><details><summary>逐项查看平台结果</summary><ul>${items.map(i=>`<li><strong>${esc(i.company)} · ${esc(i.title)}</strong><br>${outcomeLabels[i.state]}${i.source==='fixture'?' · 模拟页面':''}${i.reason?'<br>'+esc(i.reason):''}${i.evidence?'<br>回执：'+esc(i.evidence.slice(0,300)):''}</li>`).join('')}</ul></details><div class="actions">${b.state==='DRAFT'?`<button class="primary" data-review-batch="${b.id}">查看并确认具体投递内容</button>`:''}${['DRAFT','APPROVED','RUNNING','NEEDS_REVIEW'].includes(b.state)?`<button class="secondary" data-cancel-batch="${b.id}">取消剩余任务</button>`:''}</div></article>`;
    }).join('')||'<p class="batch-empty">还没有投递批次。勾选符合项后，可预览本次具体目标。</p>';
  }
  const requestedReview=window.location?new URLSearchParams(window.location.search).get('review'):null;
  let openedRequestedReview=false;
  function showReview(batch,items){
    review=batch;q('#application-approval-form').reset();q('#application-review-error').classList.add('hidden');
    q('#application-review-content').innerHTML=`<p>显示账号：<strong>${esc(batch.account_label)}</strong></p><p>执行方式：${batch.mode==='resume'?'发送BOSS中的指定简历 '+esc(batch.resume_label):'发送以下已确认招呼（仅同步为沟通中）'}</p><p class="field-help">平台“立即沟通”可能同时展示在线简历并发送BOSS设置的默认招呼。若会话已有本人已发送消息，本批次只核对已有沟通，不追加模板。以下目标和内容已冻结，修改简历或条件后需要重新准备。</p>${items.map(i=>`<article class="batch-target"><h3>${esc(i.company)} · ${esc(i.title)}</h3><a href="${esc(i.url)}" target="_blank" rel="noopener noreferrer">查看具体岗位 ↗</a><p>${batch.mode==='greeting'?esc(i.message):'发送内容：BOSS中的指定简历 '+esc(batch.resume_label)}</p><p class="muted">${i.source==='fixture'?'仅在模拟页面执行':'真实BOSS岗位'}</p></article>`).join('')}`;
    q('#application-approval-note').textContent=batch.automatic
      ?'确认后，已开启自动化的扩展会回到 BOSS，按以上目标执行。确认有效期为15分钟。'
      :'确认后，在扩展中执行此批次。确认有效期为15分钟。';
    q('#approve-batch').textContent=batch.automatic?'确认以上目标与发送内容，自动执行':'确认以上目标与发送内容，加入执行队列';
    q('#application-review').showModal();
  }
  async function load(){
    if(loading)return;loading=true;
    try{const results=await Promise.all([api('/api/opportunities'),api('/api/applications'),api('/api/boss')]);data=results[0];deliveries=results[1];connections=results[2].connections;if(!q('#opportunity-results').contains(document.activeElement))render();
      const signature=JSON.stringify([data.opportunities.map(o=>o.favorite_id),deliveries.items.map(i=>[i.id,i.state]),data.has_resume,data.preferences.revision]);
      if(signature!==overviewSignature&&!document.activeElement?.matches('input,textarea,select')){await refresh();overviewSignature=signature;}
      if(requestedReview&&!openedRequestedReview&&!q('#application-review').open){
        openedRequestedReview=true;
        const batch=deliveries.batches.find(b=>b.id===requestedReview);
        if(batch?.state==='DRAFT')showReview(batch,deliveries.items.filter(i=>i.batch_id===batch.id).reverse());
      }
    }
    finally{loading=false;}
  }
  q('#search-preferences-form').addEventListener('submit',event=>{event.preventDefault();if(working)return;
    const openSearch=event.submitter?.value==='search',popup=openSearch?window.open('about:blank','_blank'):null;if(popup)popup.opener=null;
    void act(async()=>{try{
    const form=event.target,body={};for(const name of ['titles','cities','required_keywords','excluded_companies'])body[name]=list(form.elements[name].value);
    for(const name of ['limit','search_limit','min_score'])body[name]=Number(form.elements[name].value);
    body.min_salary_k=form.elements.min_salary_k.value===''?null:Number(form.elements.min_salary_k.value);body.min_coverage=Number(form.elements.min_coverage.value)/100;
    for(const name of ['accept_internship','accept_other_cities','auto_favorite'])body[name]=form.elements[name].checked;
    const result=await api('/api/opportunities/preferences','PUT',body);q('#preferences-status').textContent='已保存条件版本 '+result.revision;await load();
    const first=result.search_plan?.entries[0];if(openSearch&&first&&popup)popup.location.replace(first.url);else popup?.close();
    toast(openSearch&&!popup?'条件已保存。浏览器未打开新页面，请点击搜索计划中的链接。':'筛选条件已保存。已开启自动求职的扩展将按新条件搜索');
    }catch(err){popup?.close();throw err;}
  });});
  q('#application-batch-form').addEventListener('submit',event=>{event.preventDefault();void act(async()=>{
    if(!picked.size)throw Error('请先勾选符合条件且未过期的岗位');if(picked.size>10)throw Error('每个批次最多10个具体目标');
    const connection=pickedConnection();alignConnection();
    const body={...Object.fromEntries(new FormData(event.target)),connection_id:connection.id,opportunity_ids:[...picked]};
    const result=await api('/api/applications','POST',body);await load();await refresh();showReview(result.batch,result.items);
  });});
  q('#application-approval-form').addEventListener('submit',event=>{event.preventDefault();void act(async()=>{
    if(!review)throw Error('请重新打开批次预览');await api('/api/applications/'+review.id+'/approve','POST',{digest:review.digest,targets_confirmed:true,resume_confirmed:true});q('#application-review').close();await load();toast(review.automatic?'已确认，扩展将自动执行本批次':'批次已确认，可在 BOSS 扩展执行');
  });});
  document.addEventListener('change',event=>{
    if(event.target.dataset.pickOpportunity){const id=event.target.dataset.pickOpportunity;if(event.target.checked)picked.add(id);else picked.delete(id);alignConnection();}
    if(event.target.id==='application-connection'){const c=connections.find(c=>c.id===event.target.value);q('#application-batch-form').elements.account_label.value=c?.labels?.account||'';}
  });
  document.addEventListener('click',event=>{const button=event.target.closest('button');if(!button)return;
    if(button.id==='application-review-close'){q('#application-review').close();return;}
    if(button.dataset.opportunityFilter){filter=button.dataset.opportunityFilter;render();return;}
    if(button.id!=='refresh-opportunities'&&!button.dataset.favoriteOpportunity&&!button.dataset.reviewBatch&&!button.dataset.cancelBatch)return;
    void act(async()=>{
      if(button.id==='refresh-opportunities')await load();
      if(button.dataset.favoriteOpportunity){await api('/api/opportunities/'+button.dataset.favoriteOpportunity+'/favorite','POST');await load();await refresh();toast('已加入收藏机会');}
      if(button.dataset.reviewBatch){const b=deliveries.batches.find(b=>b.id===button.dataset.reviewBatch);showReview(b,deliveries.items.filter(i=>i.batch_id===b.id).reverse());}
      if(button.dataset.cancelBatch){await api('/api/applications/'+button.dataset.cancelBatch+'/cancel','POST');await load();toast('已取消剩余任务；可能已点击的动作请核对平台');}
    });
  });
  setInterval(()=>{if(!document.hidden&&['jobs','tracking'].includes(view)&&!working&&!q('#application-review').open)void load().catch(()=>{});},5000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)void load().catch(()=>{});});
  void load().catch(error);
})();
