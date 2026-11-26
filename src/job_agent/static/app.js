'use strict';
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const statuses = {saved:'已收藏', applied:'已投递', communicating:'沟通中', interview:'面试中', offer:'收到 Offer', closed:'已结束'};
const evidenceStatuses = {met:'有证据支持', partial:'部分相关', unknown:'尚无证据', unmet:'存在否定表述', conflict:'需要核实'};
const pages = {profile:['我的经历，下一站的起点','维护一份真实简历，为每个机会找到对应的经历。'], jobs:['找到适合你的下一站','把简历、机会和每一步进展，放在一起。'], tracking:['让每一次投递，都有下文','记下当前进度，也给下一步留一个时间。'], preparation:['为下一次对话，做好准备','从真实经历出发，让表达更清晰、更具体。']};
let state = {profile:null,jobs:[],model_enabled:false}, selected = '', view = 'jobs', prepKey = '', prepData = null, prepSequence = 0;
let toastTimer;
const dateTime = value => new Date(value * 1000).toLocaleString('zh-CN', {hour12:false});
function today() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function toast(message) { $('#toast').textContent=message; $('#toast').classList.remove('hidden'); clearTimeout(toastTimer); toastTimer=setTimeout(()=>$('#toast').classList.add('hidden'),3500); }
function showError(message) { const box = $('#job-modal').open ? $('#modal-error') : $('#error'); box.textContent=message; box.classList.remove('hidden'); }
async function api(path, method='GET', data) {
  const response = await fetch(path, {method, headers:{Authorization:'Bearer '+$('meta[name="local-token"]').content, ...(data!==undefined?{'Content-Type':'application/json'}:{})}, ...(data!==undefined?{body:JSON.stringify(data)}:{})});
  const body = await response.json();
  if(!response.ok) throw new Error(typeof body.detail==='string'?body.detail:'操作失败，请检查输入');
  return body;
}
function empty(title, detail, action='') { return `<div class="empty"><span class="empty-mark" aria-hidden="true">↗</span><h3>${esc(title)}</h3><p>${esc(detail)}</p>${action}</div>`; }
function jobOptions(value) { return '<option value="">请选择岗位</option>'+state.jobs.map(j=>`<option value="${esc(j.id)}" ${j.id===value?'selected':''}>${esc(j.title)} · ${esc(j.company)}</option>`).join(''); }
function evidenceHTML(items) { return items.map(e=>`<blockquote class="evidence">${esc(e.quote)}</blockquote>`).join(''); }
function renderProfile() {
  const form=$('#profile-form'), p=state.profile;
  for(const name of ['name','target','city','text']) form.elements[name].value=p?.[name]||'';
  $('#resume-version').textContent=p?`版本 ${p.revision} · ${dateTime(p.updated_at)}`:'尚未保存';
  $('#delete-profile').disabled=!p;
}
function renderStats() {
  const jobs=state.jobs;
  const values=[['收藏机会',jobs.length],['已投递 / 推进中',jobs.filter(j=>!['saved','closed'].includes(j.status)).length],['面试进行中',jobs.filter(j=>j.status==='interview').length],['待跟进',jobs.filter(j=>j.followup_date&&j.followup_date<=today()&&j.status!=='closed').length]];
  $('#stats').innerHTML=values.map(([label,n])=>`<div class="stat"><span>${label}</span><strong>${n}</strong></div>`).join('');
}
const matchLabels = {pending:'AI 自动匹配中', waiting_jd:'等待岗位正文', waiting_resume:'等待保存简历', waiting_key:'等待配置匹配 API', failed:'自动匹配失败'};
function renderList() {
  const query=$('#search').value.trim().toLocaleLowerCase();
  const jobs=state.jobs.filter(j=>(j.title+' '+j.company).toLocaleLowerCase().includes(query));
  $('#job-count').textContent=state.jobs.length;
  $('#job-list').innerHTML=jobs.length?jobs.map(j=>`<button class="job-item ${j.id===selected?'selected':''}" data-select="${esc(j.id)}" aria-pressed="${j.id===selected}"><h3>${esc(j.title)}</h3><p>${esc(j.company)}${j.city?' · '+esc(j.city):''}</p><div class="job-meta"><span class="badge">${statuses[j.status]}</span><span class="muted">${j.report?`证据覆盖 ${Math.round(j.report.coverage*100)}%`:(matchLabels[j.auto_match_state]||'待匹配')}</span></div></button>`).join(''):empty(state.jobs.length?'没有搜索结果':'先收藏一个机会',state.jobs.length?'换个岗位或公司名称试试。':'把感兴趣的岗位放进来，逐个了解。');
}
function renderDetail() {
  const job=state.jobs.find(j=>j.id===selected);
  if(!job) { $('#job-detail').innerHTML=empty('从一个目标开始','保存简历，添加岗位，查看匹配依据。','<button class="primary" data-view="profile">完善我的简历</button>'); return; }
  const report=job.report;
  const auto=job.auto_match_state;
  const matchAction=auto&&auto!=='failed'
    ? `<span role="status" class="badge">${matchLabels[auto]}</span>`
    : `<button class="primary" data-assess="${esc(job.id)}" ${!state.profile?'disabled':''}>${report?'重新匹配':auto==='failed'?'重试匹配':'开始匹配'}</button>`;
  const guidance={pending:'AI 正在按岗位正文提取要求并核对简历，结果会自动显示。',waiting_jd:'取得完整岗位描述后会自动匹配。',waiting_resume:'保存个人简历后会自动匹配。',waiting_key:'在工作台顶部配置匹配 API 后会自动匹配。',failed:job.auto_match_error};
  const rows=job.requirements_need_review?'':report?report.rows.map(row=>{
    const req=job.requirements.find(r=>r.id===row.requirement_id);
    return `<article class="report-row"><header><h3>${esc(req.text)}</h3><span class="badge ${row.status==='met'?'green':row.status==='unknown'?'':'amber'}">${evidenceStatuses[row.status]}</span></header><p>${esc(row.reason)}</p>${evidenceHTML(row.evidence)}</article>`;
  }).join(''):job.requirements.map(r=>`<article class="report-row"><h3>${esc(r.text)}</h3><p>关键词：${esc(r.keywords.join('、'))} · 权重 ${r.weight}</p></article>`).join('');
  $('#job-detail').innerHTML=`<div class="detail-top"><div><h2>${esc(job.title)}</h2><p>${esc(job.company)}${job.city?' · '+esc(job.city):''}</p></div>${matchAction}</div>${!state.profile?'<div class="notice">请先在“我的简历”保存个人经历，再开始匹配。</div>':''}${job.url?`<a href="${esc(job.url)}" target="_blank" rel="noopener noreferrer">查看原始岗位 ↗</a>`:''}${report?`<div class="score-panel"><div><span class="big-score">${report.score??'—'}</span><p>证据参考分 / 100</p></div><div><h3>证据覆盖 ${Math.round(report.coverage*100)}%</h3><p>未验证的要求不计零分，也不代表不适合。</p><p>${report.engine==='model'?'API · '+esc(report.model):'历史关键词评分，需重新匹配'} · 简历版本 ${report.resume_revision}</p></div></div><div class="notice">${esc(report.warning)}</div>`:`<div class="notice">${esc(guidance[auto]||'逐条核对简历与岗位要求，保留可回看的原文证据。')}</div>`}${rows}${job.description?`<details><summary>查看岗位描述</summary><p class="jd">${esc(job.description)}</p></details>`:''}<div class="actions"><button class="secondary" data-prepare="${esc(job.id)}" ${!report?'disabled':''}>准备面试与沟通</button><button class="text-button danger" data-delete="${esc(job.id)}">删除岗位</button></div><form id="tracking-form" class="tracking-form"><h3>记录当前进度</h3><div class="form-grid"><label>投递状态<select name="status">${Object.entries(statuses).map(([k,v])=>`<option value="${k}" ${k===job.status?'selected':''}>${v}</option>`).join('')}</select></label><label>下次跟进日期<input name="followup_date" type="date" value="${esc(job.followup_date)}"></label></div><label>跟进备注<textarea name="notes" rows="3" maxlength="5000" placeholder="例如：已约周五电话沟通，提前整理项目经历。">${esc(job.notes)}</textarea></label><button class="secondary" type="submit">保存进度</button></form><ul class="history">${job.history.slice().reverse().map(h=>`<li>${esc(dateTime(h.at))} · ${statuses[h.status]}</li>`).join('')}</ul>`;
  window.renderBossPanel?.(job);
}
function renderTracking() {
  if(!state.jobs.length) { $('#tracking-board').innerHTML=empty('给每个机会一个位置','收藏岗位后，即可记录投递进度。'); return; }
  $('#tracking-board').innerHTML=Object.entries(statuses).map(([key,label])=>{
    const jobs=state.jobs.filter(j=>j.status===key).sort((a,b)=>(a.followup_date||'9999').localeCompare(b.followup_date||'9999'));
    return `<section class="tracking-column"><h3>${label}<span class="count">${jobs.length}</span></h3>${jobs.map(j=>`<article class="tracking-card"><h3>${esc(j.title)}</h3><p>${esc(j.company)}</p>${j.followup_date?`<p class="${j.followup_date<=today()&&key!=='closed'?'due':''}">${j.followup_date<=today()&&key!=='closed'?'待跟进 · ':''}${esc(j.followup_date)}</p>`:''}${j.notes?`<p>${esc(j.notes)}</p>`:''}<button data-track="${esc(j.id)}">查看 / 更新进度</button></article>`).join('')||'<p class="muted">暂无记录</p>'}</section>`;
  }).join('');
}
function renderPrep(data) {
  if(!data) { $('#preparation').innerHTML=empty('先选择一个目标岗位','完成岗位匹配后，生成有依据的面试准备清单。'); return; }
  $('#preparation').innerHTML=`<div class="notice">${esc(data.notice)}</div><div class="prep-grid"><section class="card"><h2>把岗位要求，讲成你的真实案例</h2>${data.questions.map((q,i)=>`<article class="question"><span class="eyebrow">QUESTION ${String(i+1).padStart(2,'0')}</span><h3>${esc(q.requirement)}</h3><span class="badge">${evidenceStatuses[q.status]}</span><p>${esc(q.question)}</p>${evidenceHTML(q.evidence)}<p class="muted">${esc(q.tip)}</p><label>回答结构<textarea rows="3" placeholder="目标 → 我的行动 → 真实结果 → 复盘（练习内容仅保留在当前页面）"></textarea></label></article>`).join('')}</section><aside><section class="card"><div class="section-heading"><h2>初次沟通草稿</h2><button id="copy-greeting" class="text-button">复制</button></div><p class="copy-area">${esc(data.greeting)}</p><p class="field-help">核对事实后，自行发送。</p></section><section class="card"><h2>你也可以问对方</h2>${data.ask_employer.map(q=>`<p class="muted">${esc(q)}</p>`).join('')}</section></aside></div>`;
}
async function loadPrep(key) {
  prepKey=key; const sequence=++prepSequence;
  $('#prep-job').value=key; prepData=null;
  if(!key) { renderPrep(null); return; }
  $('#preparation').innerHTML='<p class="preparing">正在整理准备清单…</p>';
  try { const data=await api(`/api/jobs/${encodeURIComponent(key)}/preparation`); if(sequence!==prepSequence)return; prepData=data; renderPrep(data); }
  catch(error) { if(sequence!==prepSequence)return; $('#preparation').innerHTML=empty('还差一步',error.message,'<button class="primary" data-return-job>前往岗位匹配</button>'); }
}
function switchView(name, updateHash=true) {
  if(!pages[name])name='jobs'; view=name;
  document.querySelectorAll('.view').forEach(el=>el.classList.toggle('hidden',el.id!==name+'-view'));
  document.querySelectorAll('nav [data-view]').forEach(el=>{el.classList.toggle('active',el.dataset.view===name); if(el.dataset.view===name)el.setAttribute('aria-current','page');else el.removeAttribute('aria-current');});
  $('#page-title').textContent=pages[name][0]; $('#page-description').textContent=pages[name][1];
  if(updateHash)history.replaceState(null,'','#'+name);
  if(name==='preparation'&&!prepData)void loadPrep(prepKey||selected);
}
async function refresh(fillProfile=false) {
  state=await api('/api/overview');
  if(!state.jobs.some(j=>j.id===selected))selected=state.jobs[0]?.id||'';
  if(!state.jobs.some(j=>j.id===prepKey))prepKey=selected;
  $('#model-mode').textContent=state.model_enabled?'匹配 API · '+state.model_name:'匹配 API · 待配置';
  $('#demo-button').classList.toggle('hidden',!!state.profile||state.jobs.length>0);
  $('#prep-job').innerHTML=jobOptions(prepKey);
  renderStats(); renderList(); renderDetail(); renderTracking();
  if(fillProfile)renderProfile();
}
async function busy(button, work) {
  if(button)button.disabled=true;
  $('#error').classList.add('hidden'); $('#modal-error').classList.add('hidden');
  try { await work(); } catch(error) { showError(error.message); } finally { if(button?.isConnected)button.disabled=button.id==='delete-profile'&&!state.profile; }
}
document.addEventListener('click', event=>{
  const button=event.target.closest('button'); if(!button)return;
  if(button.closest('#model-settings')||button.id==='model-mode')return;
  if(button.dataset.view){switchView(button.dataset.view);return;}
  if(button.dataset.select){selected=button.dataset.select; renderList();renderDetail();return;}
  if(button.id==='new-job'){ $('#modal-error').classList.add('hidden');$('#job-modal').showModal();return; }
  if(button.id==='close-modal'){$('#job-modal').close();return;}
  void busy(button,async()=>{
    if(button.id==='demo-button'){await api('/api/demo','POST');await refresh(true);toast('已载入虚构演示数据');}
    if(button.dataset.assess){const label=button.textContent;button.textContent='正在匹配…';try{await api(`/api/jobs/${button.dataset.assess}/assess`,'POST');prepData=null;await refresh();toast('匹配完成，请核对原文');}finally{button.textContent=label;}}
    if(button.dataset.delete&&confirm('删除该岗位及其匹配报告和投递记录？')){await api(`/api/jobs/${button.dataset.delete}`,'DELETE');prepData=null;await refresh();toast('岗位已删除');}
    if(button.id==='delete-profile'&&confirm('删除已保存的简历？所有岗位匹配报告也会清除。')){await api('/api/profile','DELETE');prepData=null;await refresh(true);toast('简历及匹配报告已删除');}
    if(button.dataset.prepare){prepData=null;prepKey=button.dataset.prepare;switchView('preparation');}
    if(button.dataset.track){selected=button.dataset.track;renderList();renderDetail();switchView('jobs');$('#tracking-form').scrollIntoView({block:'center'});}
    if(button.hasAttribute('data-return-job')){selected=prepKey;renderList();renderDetail();switchView('jobs');}
    if(button.id==='copy-greeting'){await navigator.clipboard.writeText(prepData.greeting);toast('沟通草稿已复制');}
  });
});
$('#model-mode').onclick=()=>{
  $('#model-error').textContent='';
  $('#model-info').textContent='当前模型 '+(state.model_name||'deepseek-flash')+(state.model_enabled?'，已配置密钥。':'，等待设置密钥。');
  $('#model-settings').showModal();
};
$('#model-close').onclick=()=>$('#model-settings').close();
$('#model-settings').addEventListener('close',()=>$('#model-key-form').reset());
$('#model-key-form').addEventListener('submit',async event=>{
  event.preventDefault();
  const button=event.submitter;
  button.disabled=true;
  try{
    await api('/api/model/key','PUT',{key:event.target.elements.key.value.trim()});
    $('#model-settings').close();await refresh();toast('匹配 API 密钥已保存');
  }catch(error){$('#model-error').textContent=error.message;}
  finally{button.disabled=false;}
});
$('#profile-form').addEventListener('submit',event=>{event.preventDefault();void busy(event.submitter,async()=>{const data=Object.fromEntries(new FormData(event.target));await api('/api/profile','PUT',data);prepData=null;await refresh(true);toast('简历已保存；岗位报告需重新匹配');});});
$('#job-form').addEventListener('submit',event=>{event.preventDefault();void busy(event.submitter,async()=>{
  const data=Object.fromEntries(new FormData(event.target)), lines=data.requirements.split('\n').map(l=>l.trim()).filter(Boolean);
  if(lines.length<1||lines.length>8)throw new Error('请填写1至8条要求');
  data.requirements=lines.map((line,i)=>{const parts=line.split('|').map(p=>p.trim());if(parts.length!==3)throw new Error(`第${i+1}行格式应为：要求 | 关键词 | 权重`); const weight=Number(parts[2]);if(!Number.isInteger(weight)||weight<1||weight>5)throw new Error(`第${i+1}行权重应为1至5的整数`);return {id:'R'+(i+1),text:parts[0],keywords:parts[1].split(/[,，、]/).map(k=>k.trim()).filter(Boolean),weight};});
  const job=await api('/api/jobs','POST',data);selected=job.id;await refresh();$('#job-modal').close();event.target.reset();switchView('jobs');toast('岗位已收藏');
});});
document.addEventListener('submit',event=>{if(event.target.id!=='tracking-form')return;event.preventDefault();void busy(event.submitter,async()=>{await api(`/api/jobs/${selected}/tracking`,'PUT',Object.fromEntries(new FormData(event.target)));await refresh();toast('进度已保存');});});
$('#resume-file').addEventListener('change',event=>{const file=event.target.files[0];if(!file)return;void busy(null,async()=>{
  if(file.size>10*1024*1024)throw new Error('文件不能超过10MB');
  if($('#resume-text').value.trim()&&!confirm('用导入的文件文字替换编辑框中的简历？'))return;
  const content=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error('文件读取失败'));reader.readAsDataURL(file);});
  const result=await api('/api/files/extract','POST',{name:file.name,content});$('#resume-text').value=result.text;toast('文字已导入，请检查后保存简历');
}).finally(()=>{event.target.value='';});});
$('#search').addEventListener('input',renderList);
$('#prep-job').addEventListener('change',event=>void loadPrep(event.target.value));
window.addEventListener('hashchange',()=>switchView(location.hash.slice(1),false));
void busy(null,async()=>{await refresh(true);switchView(location.hash.slice(1)||'jobs');});
