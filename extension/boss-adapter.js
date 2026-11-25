/* Reuses the original connector's unique-visible-element and native-input-setter design. */
(function(root){
  'use strict';
  class JobPageAdapter {
    constructor(doc, profile){
      this.doc=doc;this.profile=profile;this.filled=new Set();this.viewSession=null;this.viewObserver=null;
      this.onLeave=()=>this.clearView();doc.defaultView.addEventListener('pagehide',this.onLeave);
    }
    clearView(){this.viewSession=null;this.viewObserver?.disconnect();this.viewObserver=null;}
    dispose(){this.clearView();this.doc.defaultView.removeEventListener('pagehide',this.onLeave);}
    visible(el){
      if(!el?.isConnected)return false;
      for(let p=el;p&&p.nodeType===1;p=p.parentElement){const s=this.doc.defaultView.getComputedStyle(p);if(p.hidden||p.getAttribute('aria-hidden')==='true'||s.display==='none'||s.visibility==='hidden')return false;}
      return true;
    }
    unique(selector, context=this.doc){
      if(!selector||typeof selector!=='string')throw Error('请先填写页面适配配置');
      const nodes=[...context.querySelectorAll(selector)].filter(el=>this.visible(el));
      if(nodes.length!==1)throw Error('选择器应唯一匹配可见元素：'+selector+'，当前 '+nodes.length+' 个');
      return nodes[0];
    }
    text(el){return (el.innerText??el.textContent??'').trim();}
    id(selector,attr){
      if(!attr||!/^data-[\w-]+$/.test(attr))throw Error('身份必须来自页面中明确的 data-* 稳定属性，不能使用姓名或DOM序号');
      const value=this.unique(selector).getAttribute(attr);
      if(!value||value.length>200)throw Error('页面缺少稳定身份属性：'+attr);
      return value;
    }
    guard(){
      const location=this.doc.location;
      if(location&&/\/web\/passport\/|\/web\/user\//.test(location.pathname))throw Error('当前为登录或安全验证页，请在 BOSS 页面自行完成后再诊断');
      const blocked=this.profile.blockedSelector;
      if(blocked&&[...this.doc.querySelectorAll(blocked)].some(el=>this.visible(el)))throw Error('页面显示登录或验证提示，已停止连接');
    }
    inspect(){
      this.guard();
      const nodes=[...this.doc.querySelectorAll('h1,h2,h3,a,div,p,span,textarea,[contenteditable]')].filter(el=>this.visible(el)&&!el.closest('.job-list-container'));
      const chatDOM=[...this.doc.querySelectorAll('.chat-message > *, .chat-record > *, .chat-position-content, .chat-position-content *, .chat-conversation .user-info, .user-nav a, #chat-input, .user-list-content > *')].filter(el=>this.visible(el)).slice(0,80).map(el=>({
        tag:el.tagName.toLowerCase(),classes:[...el.classList],attributes:Object.fromEntries([...el.attributes].filter(a=>(a.name==='id'||a.name==='href'||a.name==='contenteditable'||/^data-(?!v-)/.test(a.name))&&a.value.length<300).map(a=>[a.name,a.value])),
        children:[...el.children].slice(0,5).map(c=>({tag:c.tagName.toLowerCase(),classes:[...c.classList],text:this.text(c).slice(0,80),attributes:Object.fromEntries([...c.attributes].filter(a=>a.name==='id'||a.name==='href'||/^data-(?!v-)/.test(a.name)).map(a=>[a.name,a.value]))}))
      }));
      return {path:this.doc.location.pathname,chatDOM,elements:nodes.filter(el=>/job|company|chat|message|user|boss|geek/i.test(typeof el.className==='string'?el.className:'')||/^H[123]$/.test(el.tagName)).slice(0,100).map(el=>({
        selector:el.tagName.toLowerCase()+(el.id?'#'+CSS.escape(el.id):[...el.classList].map(c=>'.'+CSS.escape(c)).join('')),
        attributes:Object.fromEntries([...el.attributes].filter(a=>/^data-(?!v-)/.test(a.name)&&a.value.length<200).map(a=>[a.name,a.value])),
        text:this.text(el).slice(0,90),href:el.tagName==='A'?new URL(el.getAttribute('href')||'',this.doc.location.href).pathname:undefined,
        children:el.matches('.job-detail-body')?[...el.children].map(c=>({selector:c.tagName.toLowerCase()+[...c.classList].map(n=>'.'+CSS.escape(n)).join(''),text:this.text(c).slice(0,90)})):undefined
      }))};
    }
    job(){
      this.guard(); const p=this.profile, location=this.doc.location;
      if(location.hostname==='www.zhipin.com'&&/^\/job_detail\/[\w-]+\.html$/.test(location.pathname))return this.detailJob();
      const jobUrl=p.jobUrlSelector?new URL(this.unique(p.jobUrlSelector).getAttribute('href'),location.href):new URL(location.href);
      if(p.jobUrlSelector&&(jobUrl.protocol!=='https:'||jobUrl.hostname!=='www.zhipin.com'))throw Error('岗位详情链接不是BOSS官方地址');
      const match=jobUrl.pathname.match(/^\/job_detail\/([\w-]+)\.html$/);
      const external_id=match?match[1]:this.id(p.jobSelector,p.jobAttribute);
      const title=this.text(this.unique(p.titleSelector)),company=this.text(this.unique(p.companySelector)),description=this.text(this.unique(p.descriptionSelector));
      if(p.verifyTitleSelector&&this.text(this.unique(p.verifyTitleSelector))!==title)throw Error('选中岗位与展开详情不一致，请等待页面完成切换');
      if(title.length<2||title.length>80||!company||company.length>100||description.length<20||description.length>20000)throw Error('岗位正文不足或字段过长，请检查选择器范围');
      return {external_id,title,company,description,city:p.citySelector?this.text(this.unique(p.citySelector)):'',url:jobUrl.origin+jobUrl.pathname};
    }
    importContext(){
      this.guard();
      if(this.doc.location.pathname!=='/web/geek/chat')return {kind:'job',job:this.job()};
      const title=this.text(this.unique(this.profile.viewPositionSelector||'.chat-position-content')).split('\n')[0].trim().replace(/[（(]猎头职位[）)]$/, '').trim();
      let company=this.text(this.unique(this.profile.viewConversationSelector||'.chat-conversation .user-info')).split('\n')[1]?.trim()||'';
      if(['猎头顾问','猎头','招聘者','更多','HR','人事'].includes(company))company='';
      if(!title)throw Error('请先在聊天页选中一个会话，展开岗位信息后再导入');
      return {kind:'chat',title,company};
    }
    openChatJob(){
      const context=this.importContext();if(context.kind!=='chat')throw Error('当前不是聊天岗位页');
      const position=this.unique(this.profile.viewPositionSelector||'.chat-position-content');
      const matches=[...position.querySelectorAll('a,button,div,span')].filter(el=>this.visible(el)&&/^查看职位(?:\s|$)/.test(this.text(el)));
      const controls=matches.filter(el=>!matches.some(other=>other!==el&&el.contains(other)));
      if(controls.length!==1)throw Error('未找到唯一的“查看职位”入口，请先在聊天页手动打开岗位详情');
      controls[0].click();return {opened:true};
    }
    jobLink(){
      this.guard();
      const link=this.unique(this.profile.chatJobUrlSelector||'.chat-position-content a[href*="/job_detail/"]');
      return {url:JobJD.officialURL(new URL(link.getAttribute('href'),this.doc.location.href).href)};
    }
    detailJob(){this.guard();return JobJD.read(this.doc,this.doc.location.href);}
    chat(){
      if(this.profile.captureMode==='snapshot')return this.snapshot();
      this.guard(); const p=this.profile;
      const binding={account:this.id(p.accountSelector,p.accountAttribute),job:this.id(p.jobSelector,p.jobAttribute),conversation:this.id(p.conversationSelector,p.conversationAttribute)};
      return {binding,messages:this.readMessages(true)};
    }
    readMessages(stable){
      const p=this.profile;
      const container=this.unique(p.messagesContainer);
      const nodes=[...container.querySelectorAll(p.messageSelector)].filter(el=>this.visible(el));
      if(nodes.length>200)throw Error('可见消息超过200条，请缩小当前会话范围');
      const messages=nodes.map(el=>{
        const event_key=stable?el.getAttribute(p.messageIdAttribute):'';
        if(stable&&(!event_key||event_key.length>200))throw Error('消息缺少稳定ID，无法安全去重');
        const outgoing=el.matches(p.outgoingSelector),incoming=el.matches(p.incomingSelector);
        if(outgoing===incoming)throw Error('消息方向不明确，必须区分本人和招聘方');
        const text=this.text(this.unique(p.messageTextSelector,el));
        if(!text||text.length>6000)throw Error('消息为空或过长');
        return {event_key,role:outgoing?'me':'recruiter',text};
      });
      if(stable&&new Set(messages.map(m=>m.event_key)).size!==messages.length)throw Error('出现重复消息ID，已停止同步');
      return messages;
    }
    viewContext(){
      this.guard();const p=this.profile;
      const account=this.unique(p.viewAccountSelector),conversation=this.unique(p.viewConversationSelector),position=this.unique(p.viewPositionSelector),selection=this.unique(p.viewSelectionSelector);
      const labels={account:this.text(account),conversation:this.text(conversation),position:this.text(position)};
      if(Object.values(labels).some(v=>!v||v.length>160))throw Error('当前会话名称或岗位信息不完整，请先展开一个聊天');
      const signature=JSON.stringify([labels,account.querySelector('img')?.getAttribute('src')||'']);
      return {labels,signature,nodes:[account,conversation,position,selection]};
    }
    bindChat(){
      if(this.profile.captureMode!=='snapshot')return this.chat();
      const context=this.viewContext();this.clearView();
      const nonce=this.doc.defaultView.crypto.randomUUID();
      // These are page-session handles, never claimed to be platform account/message IDs.
      this.viewSession={...context,binding:{account:'view:'+nonce,job:'view:'+nonce,conversation:'view:'+nonce}};
      this.viewObserver=new this.doc.defaultView.MutationObserver(()=>this.clearView());
      for(const node of new Set(context.nodes.slice(0,3)))this.viewObserver.observe(node,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['class','src','href']});
      this.viewObserver.observe(context.nodes[3],{attributes:true,attributeFilter:['class','data-id','data-uid']});
      return this.snapshot();
    }
    snapshot(){
      const context=this.viewContext();
      if(this.viewSession){
        if(this.doc.hidden)throw Error('绑定页面在后台，请返回该页面后核对并手动恢复');
        if(context.signature!==this.viewSession.signature||context.nodes.some((node,i)=>node!==this.viewSession.nodes[i])){
          this.clearView();throw Error('页面、账号显示或招聘方已变化，请重新确认并绑定当前会话');
        }
      }
      return {capture_mode:'snapshot',labels:context.labels,binding:this.viewSession?.binding||null,needs_bind:!this.viewSession,messages:this.readMessages(false)};
    }
    fill(action,expected,manualConfirmed=false){
      if(this.profile.captureMode==='snapshot'&&!manualConfirmed)throw Error('快照模式需要在扩展中逐次核对并点击填入');
      const now=this.chat();
      if(!now.binding||JSON.stringify(now.binding)!==JSON.stringify(action.binding)||JSON.stringify({binding:now.binding,messages:now.messages})!==JSON.stringify(expected))throw Error('页面身份或消息已变化，禁止填入旧草稿');
      if(this.filled.has(action.id))throw Error('该草稿已处理，请核对输入框，禁止重复填入');
      if(typeof action.text!=='string'||!action.text.trim()||action.text.length>3000)throw Error('草稿内容无效');
      const el=this.unique(this.profile.inputSelector);
      const editable=el.isContentEditable||el.getAttribute('contenteditable')==='true';
      if(!editable&&!['TEXTAREA','INPUT'].includes(el.tagName))throw Error('配置的输入框不可编辑');
      const value=()=>editable?this.text(el):el.value;
      if(value()&&value()!==action.text)throw Error('输入框已有人工草稿，已保留原文');
      this.filled.add(action.id);
      if(editable)el.textContent=action.text;
      else{const proto=el.tagName==='TEXTAREA'?this.doc.defaultView.HTMLTextAreaElement.prototype:this.doc.defaultView.HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,action.text);}
      el.dispatchEvent(new this.doc.defaultView.Event('input',{bubbles:true}));
      if(value()!==action.text)throw Error('输入框未接受草稿，请手动核对');
      return {filled:true};
    }
  }
  root.JobPageAdapter=JobPageAdapter;
  if(typeof module!=='undefined')module.exports={JobPageAdapter};
})(typeof globalThis!=='undefined'?globalThis:window);
