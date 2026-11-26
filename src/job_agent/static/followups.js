(function(){
  'use strict';
  const details=document.querySelector('#followup-settings');
  const fields=document.querySelector('#followup-form').elements;
  const select=fields.connection,feedback=document.querySelector('#followup-feedback'),log=document.querySelector('#followup-log');
  const labels={awaiting_confirmation:'等待本人确认或发送回执',queued:'待发',sending:'发送中，待确认',reserved:'已领取，待确认',sent:'已发送',requested:'已请求发送',existing:'已有发送记录',
    failed:'发送失败，请检查机器人设置',unknown:'结果待核对',review:'需在 BOSS 核对',manual:'已人工回复',cancelled:'已取消'};
  const form=document.querySelector('#followup-form'),testButton=document.querySelector('#followup-test');
  const textFields=['account_label','message','later_message','resume_label','confirmation'];
  const path=key=>'/api/boss/connections/'+encodeURIComponent(key)+'/followup';
  const selectedKey='job-agent.followup.connection';
  const draftKey=id=>'job-agent.followup.draft.'+id;
  let loaded='',loading=false,request=0;
  function readStored(key){
    try{return JSON.parse(localStorage.getItem(key));}catch{return null;}
  }
  function store(key,value){
    try{if(value===null)localStorage.removeItem(key);else localStorage.setItem(key,JSON.stringify(value));}catch{}
  }
  function report(error){
    feedback.textContent=error instanceof TypeError
      ?'浏览器未收到本机工作台响应，请检查 8766 服务。普通字段草稿已保留。'
      :error.message;
  }
  function controls(){
    const ready=!!loaded&&select.value===loaded;
    for(const k of [...textFields,'webhook','secret','enabled'])fields[k].disabled=!ready;
    form.querySelector('[type=submit]').disabled=testButton.disabled=!ready;
  }
  form.addEventListener('input',e=>{
    if(loaded!==select.value||!loaded||!textFields.includes(e.target.name))return;
    const draft=readStored(draftKey(loaded))||{};
    draft[e.target.name]=e.target.value;store(draftKey(loaded),draft);
    feedback.textContent='已在此浏览器保留草稿，点击“保存跟进设置”生效。';
  });
  function showLog(data){
    log.replaceChildren();
    const add=text=>{const p=document.createElement('p');p.textContent=text;log.append(p);};
    for(const e of data.events)add(e.company+' · '+e.title+' · '+new Date(e.at*1000).toLocaleString()+' · HR 新消息 '+e.count+' 条 · 飞书'+(labels[e.status]||e.status)+(e.preview?' · HR：'+e.preview:'')+(e.detail?' · '+e.detail:''));
    for(const a of data.actions){
      const job=state.jobs.find(j=>j.id===a.job_id);
      add((job?job.company+' · '+job.title:'该岗位')+' · 回复'+labels[a.reply]+' · 附件'+(labels[a.resume]||'未发送')+(a.reason?' · '+a.reason:''));
    }
    if(!log.children.length)add('尚无跟进记录。');
  }
  async function load(){
    const key=select.value,token=++request;
    loaded='';feedback.textContent='';controls();log.replaceChildren();
    for(const k of [...textFields,'webhook','secret'])fields[k].value='';
    fields.enabled.checked=false;
    fields.webhook.placeholder='粘贴飞书自定义机器人地址';
    fields.secret.placeholder='启用了签名验证时填写';
    if(!key){feedback.textContent='请先配对 BOSS 连接。';return;}
    try{
      const data=await api(path(key));
      if(request!==token)return;
      const draft=readStored(draftKey(key))||{};
      for(const k of textFields)fields[k].value=draft[k]??data[k]??(k==='confirmation'?'personal':'');
      fields.enabled.checked=data.enabled;
      if(data.webhook_configured)fields.webhook.placeholder='已保存，无需重填；更换机器人时填写';
      if(data.signed)fields.secret.placeholder='已保存签名，无需重填';
      loaded=key;controls();showLog(data);
      feedback.textContent=(data.enabled?'当前已开启':'当前已关闭')+(Object.keys(draft).length?' · 已恢复未保存的草稿':'');
    }catch(error){if(request===token)report(error);}
  }
  async function initialize(){
    if(loading||loaded)return;
    loading=true;controls();
    try{
      const {connections}=await api('/api/boss');
      const active=connections.filter(c=>!c.revoked),prior=select.value||readStored(selectedKey);
      select.replaceChildren(...active.map(c=>new Option(c.label+' · '+c.id.slice(-6)+(c.auto_greeting_account?' · 已开自动招呼':''),c.id)));
      const preferred=active.find(c=>c.id===prior)||active.find(c=>c.auto_greeting_account)||active[0];
      if(preferred)select.value=preferred.id;
      await load();
    }catch(error){report(error);}finally{loading=false;}
  }
  details.addEventListener('toggle',()=>{if(details.open)void initialize();});
  select.onchange=()=>{store(selectedKey,select.value);return load();};
  form.onsubmit=async e=>{
    e.preventDefault();
    const key=loaded;
    if(!key||key!==select.value)return;
    const body={enabled:fields.enabled.checked};
    for(const k of [...textFields,'webhook','secret'])body[k]=fields[k].value.trim();
    select.disabled=true;loaded='';controls();
    try{
      await api(path(key),'PUT',body);
      store(selectedKey,key);store(draftKey(key),null);
      await load();
    }catch(error){loaded=key;controls();report(error);}finally{select.disabled=false;}
  };
  document.querySelector('#followup-refresh').onclick=async()=>{
    if(!loaded){await initialize();return;}
    const key=loaded;
    try{const data=await api(path(key));if(key===loaded)showLog(data);}
    catch(error){if(key===loaded)report(error);}
  };
  testButton.onclick=async()=>{
    const key=loaded;
    if(!key||key!==select.value)return;
    if(fields.webhook.value.trim()||fields.secret.value.trim()){
      feedback.textContent='请先保存刚填写的机器人地址或密钥，再发送测试提醒。';return;
    }
    testButton.disabled=true;
    try{await api(path(key)+'/test','POST',{});if(key===loaded)feedback.textContent='飞书已确认收到测试提醒。';}
    catch(error){if(key===loaded)report(error);}finally{if(key===loaded)testButton.disabled=false;}
  };
  controls();
  if(details.open)void initialize();
})();
