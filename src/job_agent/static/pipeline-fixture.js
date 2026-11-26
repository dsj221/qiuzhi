/* Local-only controls. This file is never injected into BOSS. */
(function(){
  'use strict';
  const q=s=>document.querySelector(s);
  const roles=[
    {id:'fixture-job-01',title:'Python 开发实习生（连接器演示）',company:'示例研发团队 · 虚构公司',city:'上海',salary:'12-18K',description:'岗位职责：参与 Python 服务开发，维护业务接口与单元测试。岗位要求：了解 Python、SQL 与 Git，能够说明自己在项目中负责的工作。'},
    {id:'fixture-job-02',title:'Python 自动化工程师（模拟）',company:'示例自动化团队 · 虚构公司',city:'杭州',salary:'15-20K',description:'岗位职责：使用 Python 开发业务服务，参与需求评审、接口调试和服务维护工作。'},
    {id:'fixture-job-03',title:'Java 开发工程师（模拟）',company:'示例软件团队 · 虚构公司',city:'上海',salary:'8-12K',description:'岗位职责：使用 Java 开发业务接口，维护企业应用，参加研发团队的代码评审和问题排查。'}
  ];
  function select(role){
    q('#fixture-job').dataset.jobId=role.id;
    for(const key of ['title','company','city','description'])q('#fixture-'+key).textContent=role[key];
    q('#fixture-target-title').textContent=role.title;q('#fixture-target-company').textContent=role.company;
    q('#fixture-chat').dataset.conversationId='chat-'+role.id;
    q('#fixture-input').value='';q('#fixture-messages').replaceChildren();
    q('#fixture-apply').textContent='立即沟通';q('#fixture-resume-dialog').hidden=true;
  }
  for(const role of roles){
    const card=document.createElement('article');card.className='fixture-job-card';card.dataset.jobId=role.id;
    const link=document.createElement('a');link.className='fixture-card-title';link.href='/boss-fixture';link.textContent=role.title;
    link.onclick=e=>{e.preventDefault();select(role);};card.append(link);
    for(const key of ['company','city','salary']){const el=document.createElement('p');el.className='fixture-card-'+key;el.textContent=role[key];card.append(el);}
    q('#fixture-list').append(card);
  }
  q('#fixture-apply').onclick=()=>{q('#fixture-target-title').textContent=q('#fixture-title').textContent;q('#fixture-target-company').textContent=q('#fixture-company').textContent;};
  q('#fixture-open-resume').onclick=()=>{q('#fixture-resume-dialog').hidden=false;q('#fixture-resume-send').disabled=true;};
  q('.fixture-resume-option').onclick=()=>{q('#fixture-resume-send').disabled=false;};
  q('#fixture-resume-send').onclick=()=>{if(q('#fixture-resume-send').disabled)return;add('me','fixture-resume.pdf 已发送给BOSS（仅本机模拟）');q('#fixture-resume-dialog').hidden=true;};
  q('#fixture-pipeline-test').onclick=async()=>{
    const results=[];let adapter;
    const saved={id:q('#fixture-job').dataset.jobId,conversation:q('#fixture-chat').dataset.conversationId,messages:q('#fixture-messages').innerHTML,input:q('#fixture-input').value,blocked:q('#fixture-blocked').hidden};
    try{
      const profile=await (await fetch('/static/fixture-profile.json')).json();adapter=new JobPipelineAdapter(document,profile);
      q('#fixture-blocked').hidden=true;
      const assert=(ok,label)=>{if(!ok)throw Error(label);results.push('✓ '+label);};
      const rejects=(fn,label)=>{let rejected=false;try{fn();}catch{rejected=true;}assert(rejected,label);};
      assert(adapter.list().length===3,'按稳定岗位ID读取三个模拟岗位');
      adapter.select('fixture-job-02');let current=adapter.current();
      assert(current.job.external_id==='fixture-job-02'&&current.job.salary_min_k===15,'逐项展开正确岗位及月薪区间');
      const action={id:'pipeline-fixture-test',...current.job,account_label:current.account_label,expires_at:Date.now()/1000+60,mode:'greeting',message:'【仅本机模拟】希望了解这个岗位。',resume_label:'fixture-resume.pdf'};
      assert(adapter.open(action).opened&&adapter.chatTarget(action).verified,'进入后核对岗位、公司与账号');
      q('#fixture-input').value='人工草稿';rejects(()=>adapter.prepareGreeting(action),'保留人工草稿，不覆盖发送');q('#fixture-input').value='';
      let prepared=adapter.prepareGreeting(action);assert(adapter.verify(action,prepared.message_ids).outcome==='UNKNOWN','填入消息不能当成已发送');
      adapter.cancel();rejects(()=>adapter.sendGreeting(action),'停止任务后禁止使用旧发送动作');
      prepared=adapter.prepareGreeting(action);adapter.sendGreeting(action);
      const greeting=adapter.verify(action,prepared.message_ids);assert(greeting.outcome==='COMMUNICATING','新招呼回执仅同步为沟通中');
      assert(adapter.verify(action,adapter.receipts().map(m=>m.id)).outcome==='UNKNOWN','历史消息不能冒充新回执');
      const resume={...action,mode:'resume'};
      rejects(()=>adapter.openResume(resume),'仅有本人招呼不能打开附件入口');
      add('recruiter','已读');
      rejects(()=>adapter.openResume(resume),'已读状态不能当作 HR 来信');
      add('recruiter','系统提示');q('#fixture-messages').lastElementChild.classList.add('item-system');
      rejects(()=>adapter.openResume(resume),'系统消息不能当作 HR 来信');
      add('recruiter','你好，可以发份简历吗？');
      const source=adapter.openResume(resume);
      resume.recruiter_receipt=source.recruiter_receipt;resume.contact=source.contact;
      rejects(()=>adapter.prepareResume({...resume,resume_label:'其他文件.pdf'}),'准确名称不匹配时禁止改发其他简历');
      prepared=adapter.prepareResume(resume);
      const row=q('#fixture-messages').lastElementChild;
      row.classList.replace('from-recruiter','from-me');
      rejects(()=>adapter.sendResume(resume),'确认前原 HR 消息无法核对时停止');
      row.classList.replace('from-me','from-recruiter');adapter.sendResume(resume);
      assert(adapter.verify(resume,prepared.message_ids).outcome==='RESUME_SENT','指定简历和新发送回执同时核验');
      const baseline=adapter.receipts().map(m=>m.id);add('me','已请求发送简历，请等待对方同意');
      assert(adapter.verify(resume,baseline).outcome==='RESUME_REQUESTED','简历请求与简历已发送分别记录');
      rejects(()=>adapter.chatTarget({...action,company:'另外一家企业'}),'招聘方不符时停止');
      assert(adapter.salary('\uE111-\uE112K').salary_min_k===null,'字体混淆的薪资不猜测数值');
      const unverified=new JobPipelineAdapter(document,{...profile,resumeChooserVerified:false});rejects(()=>unverified.openResume(resume),'未诊断选择器不会触发附件入口');unverified.dispose();
      q('#fixture-messages').replaceChildren();add('recruiter','可以发一份简历吗？');add('me','感谢回复');
      const replyId=adapter.receipts().at(-1).id;
      const direct={...action,direct_resume:true,resume_label:'',mode:'resume',lease:'fixture-direct',
        contact:current.job.company,trigger:adapter.receipts()[0].id,reply_id:replyId};
      const prompt=document.createElement('div');
      prompt.innerHTML='<p>确定向 Boss 发送简历吗？</p><p>Boss确认后，该附件简历将直接发送至对方邮箱</p><button>取消</button><button>确定</button>';
      const opener=q('#fixture-open-resume'),original=opener.onclick;
      let clicks=0;
      opener.onclick=()=>q('#fixture-resume-controls').append(prompt);
      prompt.lastElementChild.onclick=()=>{clicks++;prompt.remove();add('me','您的附件简历 示例.pdf 已发送给Boss点击查看附件');};
      try{
        adapter.openResume(direct);prepared=adapter.prepareResume(direct);
        assert(!clicks&&adapter.verify(direct,prepared.message_ids).outcome==='UNKNOWN','识别确认弹窗本身不算附件已发');
        rejects(()=>adapter.sendResume({...direct,confirmation:'personal'}),'本人确认时扩展不能代点');
        adapter.sendResume(direct);
        assert(clicks===1&&adapter.verify(direct,prepared.message_ids).outcome==='RESUME_SENT','发简历 → 确定后核对聊天中的新发送回执');
        rejects(()=>adapter.sendResume(direct),'相同确认动作不能重复发送');
      }finally{prompt.remove();opener.onclick=original;}
      q('#fixture-blocked').hidden=false;rejects(()=>adapter.open(action),'出现验证提示立即停止');
      q('#fixture-tests').textContent=results.join('\n')+'\n筛选与投递自检全部通过。仅为本机模拟，不代表真实平台已发送。';
    }catch(error){q('#fixture-tests').textContent=results.join('\n')+'\n✗ '+error.message;}
    finally{adapter?.dispose();select(roles.find(r=>r.id===saved.id)||roles[0]);q('#fixture-chat').dataset.conversationId=saved.conversation;q('#fixture-messages').innerHTML=saved.messages;q('#fixture-input').value=saved.input;q('#fixture-blocked').hidden=saved.blocked;}
  };
})();
