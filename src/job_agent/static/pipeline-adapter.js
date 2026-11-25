/* Application UI operations are separate from chat drafts and never infer success from a click. */
(function(root){
  'use strict';
  class JobPipelineAdapter extends JobPageAdapter {
    constructor(doc,profile){super(doc,profile);this.epoch=0;this.onInactive=()=>{if(doc.hidden)this.epoch++;};doc.addEventListener('visibilitychange',this.onInactive);}
    dispose(){this.epoch++;this.doc.removeEventListener('visibilitychange',this.onInactive);super.dispose();}
    cancel(){this.epoch++;}
    accountLabel(){const label=this.text(this.unique(this.profile.viewAccountSelector||'.user-nav a[href="https://www.zhipin.com/web/geek/recommend"]'));if(!label||label.length>160)throw Error('无法核对当前显示账号');return label;}
    salary(text){
      if(/\/天|日薪|\/年|年薪/.test(text))return {salary_min_k:null,salary_max_k:null};
      const m=text.match(/(\d+(?:\.\d+)?)\s*[-~–]\s*(\d+(?:\.\d+)?)\s*[kK]/);
      return {salary_min_k:m?Number(m[1]):null,salary_max_k:m?Number(m[2]):null};
    }
    list(){
      this.guard();if(this.doc.hidden)throw Error('页面在后台，已暂停采集');const p=this.profile;
      const cards=[...this.doc.querySelectorAll(p.listCardSelector||'.job-list-container .job-card-wrap')].filter(el=>this.visible(el));
      if(!cards.length){
        const empty=[...this.doc.querySelectorAll(p.listEmptySelector||'.job-list-container .job-empty-wrapper,.job-list-container .job-empty-box,.job-list-container .search-job-empty')].some(el=>this.visible(el)&&/暂无|没有找到|无符合/.test(this.text(el)));
        if(empty)return [];
        throw Error('岗位列表尚未就绪，请打开 BOSS 岗位列表，或本机多岗位模拟页');
      }
      return cards.slice(0,50).map(card=>{
        const link=this.unique(p.listTitleSelector||'a.job-name',card),url=new URL(link.getAttribute('href'),this.doc.location.href);
        const match=url.pathname.match(/^\/job_detail\/([\w-]+)\.html$/);
        const external_id=match?match[1]:card.getAttribute('data-job-id');
        if(!external_id)throw Error('列表岗位缺少稳定链接ID');
        const salaryEl=card.querySelector(p.listSalarySelector||'.job-salary');
        const salary_text=salaryEl?this.text(salaryEl):'';
        return {external_id,title:this.text(link),company:this.text(this.unique(p.listCompanySelector||'.boss-name',card)),
          city:this.text(this.unique(p.listCitySelector||'.company-location',card)),url:url.origin+url.pathname,description:'',salary_text,...this.salary(salary_text)};
      });
    }
    select(key){
      const p=this.profile;
      const cards=[...this.doc.querySelectorAll(p.listCardSelector||'.job-list-container .job-card-wrap')].filter(el=>this.visible(el));
      const matches=cards.filter(card=>{const link=card.querySelector(p.listTitleSelector||'a.job-name');if(!link)return false;const url=new URL(link.getAttribute('href'),this.doc.location.href);return (url.pathname.match(/^\/job_detail\/([\w-]+)\.html$/)?.[1]||card.getAttribute('data-job-id'))===key;});
      if(matches.length!==1)throw Error('待处理岗位已离开当前列表或出现重复，请重新采集');
      this.unique(p.listTitleSelector||'a.job-name',matches[0]).click();return {selected:true};
    }
    current(){
      const job=this.job(),meta=this.list().find(j=>j.external_id===job.external_id);
      if(!meta||meta.title!==job.title)throw Error('选中卡片与展开岗位不一致');
      return {job:{...job,salary_text:meta.salary_text,...this.salary(meta.salary_text)},account_label:this.accountLabel()};
    }
    controls(label,context=this.doc){
      const all=[...context.querySelectorAll('button,a,[role=button],span,div')].filter(el=>this.visible(el)&&this.text(el)===label&&!el.closest(this.profile.receiptContainer||'.chat-record'));
      return all.filter(el=>!all.some(other=>other!==el&&el.contains(other)));
    }
    control(label,context=this.doc){const nodes=this.controls(label,context);if(nodes.length!==1)throw Error('无法唯一识别当前操作按钮：'+label);const el=nodes[0];if(el.disabled||el.getAttribute('aria-disabled')==='true')throw Error('当前按钮不可用：'+label);return el;}
    activate(el){
      this.guard();
      if(!this.visible(el)||el.disabled||el.getAttribute('aria-disabled')==='true')throw Error('操作按钮已失效，已停止');
      el.scrollIntoView({block:'center',inline:'nearest'});
      const box=el.getBoundingClientRect(),hit=this.doc.elementFromPoint(box.left+box.width/2,box.top+box.height/2);
      if(!box.width||!box.height||!hit||!(hit===el||el.contains(hit)))throw Error('操作被弹窗或验证界面遮挡，请在平台核对后重试');
      el.click();
    }
    check(action){this.guard();if(this.doc.hidden)throw Error('页面在后台，已暂停投递');if(Date.now()/1000>action.expires_at)throw Error('投递动作已过期');if(this.accountLabel()!==action.account_label)throw Error('显示账号已变化，已停止');}
    open(action){
      this.check(action);if(this.job().external_id!==action.external_id)throw Error('当前岗位与已确认范围不一致');
      const button=this.unique(this.profile.applyOpenSelector||'.job-detail-op a.op-btn-chat');const label=this.text(button);
      if(/继续沟通|已沟通|已投递/.test(label))return {already:true,evidence:label};
      if(!['立即沟通','立即投递'].includes(label))throw Error('当前页面没有已诊断的投递入口');
      this.activate(button);return {opened:true,chat_url:this.doc.location.hostname==='www.zhipin.com'?'https://www.zhipin.com/web/geek/chat':this.doc.location.href};
    }
    selectChat(action){
      this.check(action);
      try{this.chatTarget(action);return {selected:true};}catch(error){if(/账号|验证|后台/.test(error.message))throw error;}
      const input=this.doc.querySelector(this.profile.inputSelector||'#chat-input');
      if(input&&this.visible(input)&&(input.isContentEditable?this.text(input):input.value))throw Error('当前会话有人工草稿，请先自行处理后再切换');
      const list=this.unique(this.profile.chatListSelector||'.user-list-content');
      const normalize=value=>value.replace(/\s+/g,'').toLocaleLowerCase();
      const candidates=[...list.querySelectorAll('span,div,p,a')].filter(el=>this.visible(el)&&normalize(this.text(el))===normalize(action.company));
      const labels=candidates.filter(el=>!candidates.some(other=>other!==el&&el.contains(other)));
      if(labels.length!==1)throw Error(labels.length?'同公司有多个联系人，请手动选择对应岗位的会话':'当前联系人列表尚未找到目标公司，请在BOSS搜索并选择该会话');
      this.activate(labels[0]);return {selected:true};
    }
    chatTarget(action,passive=false){
      if(passive){this.guard();if(this.doc.hidden||this.accountLabel()!==action.account_label)throw Error('当前账号或前台页面不符');}
      else this.check(action);
      const p=this.profile;
      const position=this.text(this.unique(p.viewPositionSelector||'.chat-position-content'));
      const person=this.text(this.unique(p.viewConversationSelector||'.chat-conversation .user-info'));
      const normalize=value=>value.replace(/\s+/g,'').toLocaleLowerCase();
      if(normalize(position.split('\n')[0])!==normalize(action.title)||!person.split('\n').some(line=>normalize(line)===normalize(action.company)))throw Error('当前聊天的岗位或公司与已确认目标不一致');
      const receipts=this.receipts(),outgoing=receipts.filter(m=>m.outgoing&&m.text.trim());
      return {verified:true,account_label:this.accountLabel(),message_ids:receipts.map(m=>m.id),outgoing:outgoing.map(m=>({id:m.id,text:m.text}))};
    }
    receipts(){
      const p=this.profile,selector=p.receiptMessagesSelector||'.chat-record .im-list > [data-mid]',attr=p.receiptIdAttribute||'data-mid';
      return [...this.doc.querySelectorAll(selector)].filter(el=>this.visible(el)).slice(-500).map(el=>({id:el.getAttribute(attr),text:this.text(el),outgoing:el.matches(p.outgoingSelector||'.item-myself')})).filter(m=>m.id);
    }
    prepareGreeting(action){
      this.chatTarget(action);const el=this.unique(this.profile.inputSelector||'#chat-input');
      const editable=el.isContentEditable||el.getAttribute('contenteditable')==='true';const value=editable?this.text(el):el.value;
      if(value&&value!==action.message)throw Error('输入框存在人工草稿，已保留原文');
      if(editable)el.textContent=action.message;
      else{const proto=el.tagName==='TEXTAREA'?this.doc.defaultView.HTMLTextAreaElement.prototype:this.doc.defaultView.HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,action.message);}
      el.dispatchEvent(new this.doc.defaultView.Event('input',{bubbles:true}));
      if((editable?this.text(el):el.value)!==action.message)throw Error('页面没有接受已确认消息');
      this.greetingPending={id:action.id,epoch:this.epoch};
      return {prepared:true,message_ids:this.receipts().map(m=>m.id)};
    }
    sendGreeting(action){
      this.chatTarget(action);const el=this.unique(this.profile.inputSelector||'#chat-input');const value=el.isContentEditable||el.getAttribute('contenteditable')==='true'?this.text(el):el.value;
      if(this.greetingPending?.id!==action.id||this.greetingPending?.epoch!==this.epoch)throw Error('消息动作已停止，禁止发送');
      if(value!==action.message)throw Error('消息已被修改，禁止发送');
      this.activate(this.control('发送',this.unique(this.profile.editorContainer||'.chat-im.chat-editor')));return {clicked:true};
    }
    openResume(action){
      this.chatTarget(action);
      if(this.profile.resumeChooserVerified!==true)throw Error('简历选择器尚未完成现场诊断，本次暂停；不会点击可能直接发送附件的入口');
      this.activate(this.control('发简历',this.unique(this.profile.resumeControlsContainer||'.chat-controls')));return {opened:true};
    }
    prepareResume(action){
      this.chatTarget(action);
      if(this.profile.resumeChooserVerified!==true)throw Error('简历选择器未诊断');
      const p=this.profile,dialog=this.unique(p.resumeDialogSelector);
      const options=[...dialog.querySelectorAll(p.resumeOptionSelector)].filter(el=>this.visible(el)&&(this.text(el)===action.resume_label||el.getAttribute('title')===action.resume_label));
      if(options.length!==1)throw Error('未找到唯一的已确认简历名称，不会改发其他文件');
      this.activate(options[0]);this.resumePending={actionId:action.id,dialog,option:options[0],epoch:this.epoch};
      return {prepared:true,resume_label:action.resume_label,message_ids:this.receipts().map(m=>m.id)};
    }
    sendResume(action){
      this.chatTarget(action);const pending=this.resumePending;
      if(!pending||pending.actionId!==action.id||pending.epoch!==this.epoch||!pending.option.isConnected||!this.visible(pending.dialog))throw Error('简历选择界面已变化，禁止发送');
      if(this.text(pending.option)!==action.resume_label&&pending.option.getAttribute('title')!==action.resume_label)throw Error('简历名称已变化');
      this.activate(this.unique(this.profile.resumeSendSelector,pending.dialog));this.resumePending=null;return {clicked:true};
    }
    verify(action,baseline,passive=false){
      this.chatTarget(action,passive);const fresh=this.receipts().filter(m=>!baseline.includes(m.id));
      if(action.stage==='open_chat'){
        const existing=fresh.find(m=>m.outgoing&&m.text.trim());
        return existing?{outcome:'ALREADY_CONTACTED',receipt_key:existing.id,evidence:existing.text,reason:'已核对真实会话中的已发送招呼，未追加发送模板'}:{outcome:'UNKNOWN'};
      }
      if(action.mode==='greeting'){
        const message=fresh.find(m=>m.outgoing&&m.text.includes(action.message));
        return message?{outcome:'COMMUNICATING',receipt_key:message.id,evidence:message.text}:{outcome:'UNKNOWN'};
      }
      const delivered=fresh.find(m=>{const remaining=m.text.replace(action.resume_label,'');return m.outgoing&&m.text.includes(action.resume_label)&&/已发送|发送成功|发送给/.test(remaining)&&!/未发送|发送失败|尚未发送|没有发送|请求|申请|等待.*同意/.test(remaining);});
      if(delivered)return {outcome:'RESUME_SENT',receipt_key:delivered.id,evidence:delivered.text};
      const requested=fresh.find(m=>m.outgoing&&/请求|申请|对方同意/.test(m.text)&&/简历/.test(m.text));
      return requested?{outcome:'RESUME_REQUESTED',receipt_key:requested.id,evidence:requested.text}:{outcome:'UNKNOWN'};
    }
  }
  root.JobPipelineAdapter=JobPipelineAdapter;
})(typeof globalThis!=='undefined'?globalThis:window);
