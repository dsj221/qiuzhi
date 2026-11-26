'use strict';
const inbox={session:null,seen:new Map(),expected:null};
document.addEventListener('click',event=>{
  if(event.isTrusted&&event.target.closest?.('.user-list-content li'))inbox.expected=null;
},true);
let adapter=null,pipeline=null,profileKey='';
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  if(sender.id!==chrome.runtime.id)return false;
  try{
    const key=JSON.stringify(message.profile);
    if(key!==profileKey){adapter?.dispose();pipeline?.dispose();adapter=new JobPageAdapter(document,message.profile);pipeline=new JobPipelineAdapter(document,message.profile);profileKey=key;}
    if(message.type==='INSPECT')reply({ok:true,data:adapter.inspect()});
    else if(message.type==='READ_JOB')reply({ok:true,data:adapter.job()});
    else if(message.type==='JOB_IMPORT_CONTEXT')reply({ok:true,data:adapter.importContext()});
    else if(message.type==='OPEN_CHAT_JOB')reply({ok:true,data:adapter.openChatJob()});
    else if(message.type==='READ_JOB_LINK')reply({ok:true,data:adapter.jobLink()});
    else if(message.type==='READ_DETAIL_JOB')reply({ok:true,data:adapter.detailJob()});
    else if(message.type==='READ_CHAT')reply({ok:true,data:adapter.chat()});
    else if(message.type==='BIND_CHAT')reply({ok:true,data:adapter.bindChat()});
    else if(message.type==='UNBIND_CHAT'){adapter.clearView();reply({ok:true,data:{ok:true}});}
    else if(message.type==='FILL')reply({ok:true,data:adapter.fill(message.action,message.expected,message.manual_confirmed===true)});
    else if(message.type==='PIPE_ACCOUNT'){pipeline.guard();if(document.hidden)throw Error('页面在后台，已停止');reply({ok:true,data:{account_label:pipeline.accountLabel()}});}
    else if(message.type==='PIPE_LIST')reply({ok:true,data:{jobs:pipeline.list(),account_label:pipeline.accountLabel(),list_url:document.location.href,page_title:document.title}});
    else if(message.type==='PIPE_SELECT')reply({ok:true,data:pipeline.select(message.external_id)});
    else if(message.type==='PIPE_CURRENT')reply({ok:true,data:pipeline.current()});
    else if(message.type==='PIPE_OPEN')reply({ok:true,data:pipeline.open(message.action)});
    else if(message.type==='FOLLOW_DIAGNOSE')reply({ok:true,data:pipeline.diagnoseResume(message.label)});
    else if(message.type==='FOLLOW_NAV_READY'){
      pipeline.guard();
      const input=document.querySelector(pipeline.profile.inputSelector||'#chat-input');
      const draft=input&&pipeline.visible(input)&&(input.isContentEditable?pipeline.text(input):input.value||'').trim();
      const dialog=pipeline.profile.resumeDialogSelector||'dialog,[role="dialog"],.dialog-wrap,.dialog-container';
      const pending=[...document.querySelectorAll(dialog)].some(el=>pipeline.visible(el))||pipeline.directPrompt();
      reply({ok:true,data:{ready:!draft&&!pending,reason:draft?'输入框有草稿，等待你处理':pending?'请在当前会话处理确认窗口':''}});
    }
    else if(message.type==='FOLLOW_OPEN_CHAT'){
      const p=pipeline.profile;
      const header=document.querySelector(p.viewConversationSelector),position=document.querySelector(p.viewPositionSelector);
      if(!header||!position||!pipeline.visible(header)||!pipeline.visible(position)){reply({ok:true,data:{}});return;}
      const contact=pipeline.text(header),title=pipeline.text(position).split('\n')[0];
      const company=contact.split('\n').filter(Boolean)[1]||'当前招聘方';
      const expected=inbox.expected;
      if(expected&&(expected.name!==contact.split('\n')[0]||!expected.labels.includes(company))){
        reply({ok:true,data:{waiting:'正在等待新来信的会话加载'}});return;
      }
      const target={...message.action,title,contact,company,manual_chat:true};
      const known=message.items.filter(i=>i.title.replace(/\s/g,'')===title.replace(/\s/g,'')&&
        (i.contact?i.contact===contact:contact.split('\n').some(l=>l.trim()===i.company)));
      if(known.length>1)throw Error('当前岗位匹配了多个投递会话');
      const snapshot=pipeline.followRead(target);
      if(expected){
        if(snapshot.messages.at(-1).id===expected.previousId){
          reply({ok:true,data:{waiting:'正在等待对应的聊天记录加载'}});return;
        }
        inbox.expected=null;
      }
      const input=document.querySelector(p.inputSelector);
      const drafting=!!input&&(input.isContentEditable?pipeline.text(input):input.value||'').trim()!=='';
      reply({ok:true,data:{title,company,snapshot,drafting,id:known[0]?.id}});
    }
    else if(message.type==='FOLLOW_HINT'){
      const clean=s=>s.replace(/\s+/g,'').toLowerCase();
      let matches=[];
      if(message.reason==='chat'){
        const person=pipeline.text(pipeline.unique(pipeline.profile.viewConversationSelector)).split('\n').map(clean);
        const title=clean(pipeline.text(pipeline.unique(pipeline.profile.viewPositionSelector)).split('\n')[0]);
        matches=message.items.filter(i=>clean(i.title)===title&&person.includes(clean(i.company)));
      }else if(changedRow?.isConnected){
        const labels=[...changedRow.querySelectorAll('span,p,div,a')].map(n=>clean(pipeline.text(n)));
        matches=message.items.filter(i=>labels.includes(clean(i.company)));
      }
      reply({ok:true,data:{id:matches.length===1?matches[0].id:null}});
    }
    else if(message.type==='FOLLOW_READ')reply({ok:true,data:pipeline.followRead(message.action)});
    else if(message.type==='FOLLOW_OPEN_UNREAD')reply({ok:true,data:pipeline.openUnread(message.action,inbox)});
    else if(message.type==='PIPE_SELECT_CHAT')reply({ok:true,data:pipeline.selectChat(message.action)});
    else if(message.type==='PIPE_TARGET')reply({ok:true,data:pipeline.chatTarget(message.action)});
    else if(message.type==='PIPE_PREPARE_GREETING')reply({ok:true,data:pipeline.prepareGreeting(message.action)});
    else if(message.type==='PIPE_SEND_GREETING'){
      pipeline.sendGreetingWhenReady(message.action).then(
        data=>reply({ok:true,data}),error=>reply({ok:false,error:error.message}));
      return true;
    }
    else if(message.type==='PIPE_OPEN_RESUME')reply({ok:true,data:pipeline.openResume(message.action)});
    else if(message.type==='PIPE_PREPARE_RESUME')reply({ok:true,data:pipeline.prepareResume(message.action)});
    else if(message.type==='PIPE_SEND_RESUME')reply({ok:true,data:pipeline.sendResume(message.action)});
    else if(message.type==='PIPE_VERIFY')reply({ok:true,data:pipeline.verify(message.action,message.baseline)});
    else if(message.type==='PIPE_SYNC_VERIFY')reply({ok:true,data:pipeline.verify(message.action,message.action.baseline_ids,true)});
    else if(message.type==='PIPE_CANCEL'){pipeline.cancel();reply({ok:true,data:{cancelled:true}});}
    else reply({ok:false,error:'不支持的页面操作'});
  }catch(error){reply({ok:false,error:error.message});}
});

// Only send wake-up signals. The authorized scanner reads the bound conversation
// again before taking any action. The timer also picks up missed inbox changes.
let changedRow=null;
if(location.hostname==='www.zhipin.com'){
  let wakeTimer,queuedReason;
  const observing=()=>location.pathname==='/web/geek/chat'&&!document.hidden&&!!chrome.runtime.id;
  function wake(reason){
    if(observing())chrome.runtime.sendMessage({type:'FOLLOW_WAKE',reason}).catch(()=>{});
  }
  function schedule(reason){
    if(reason==='chat'||!queuedReason)queuedReason=reason;
    if(wakeTimer)return;
    wakeTimer=setTimeout(()=>{wakeTimer=null;const next=queuedReason;queuedReason=null;wake(next);},180);
  }
  const observer=new MutationObserver(records=>{
    if(!observing())return;
    for(const record of records){
      const target=record.target.nodeType===1?record.target:record.target.parentElement;
      if(target?.closest('.user-list-content')){
        changedRow=target.closest('li,[role="listitem"],.user-item,.user-list-item,.friend-item');
        schedule('inbox');
      }
      if(record.type==='childList'&&[...record.addedNodes].some(n=>n.nodeType===1&&
          (n.matches('.user-list-content')||n.querySelector('.user-list-content'))))schedule('inbox');
      if(target?.closest('.chat-record')&&(target.closest('.item-friend')||
          [...record.addedNodes].some(n=>n.nodeType===1&&(n.matches('.item-friend')||n.querySelector('.item-friend'))))){
        schedule('chat');
      }
    }
  });
  observer.observe(document.documentElement,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['class','aria-label','data-unread-count']});
  const fallback=setInterval(()=>wake(null),5000);
  window.addEventListener('pagehide',()=>{observer.disconnect();clearInterval(fallback);clearTimeout(wakeTimer);},{once:true});
}
