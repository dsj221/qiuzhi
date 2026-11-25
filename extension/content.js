'use strict';
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
    else if(message.type==='PIPE_SELECT_CHAT')reply({ok:true,data:pipeline.selectChat(message.action)});
    else if(message.type==='PIPE_TARGET')reply({ok:true,data:pipeline.chatTarget(message.action)});
    else if(message.type==='PIPE_PREPARE_GREETING')reply({ok:true,data:pipeline.prepareGreeting(message.action)});
    else if(message.type==='PIPE_SEND_GREETING')reply({ok:true,data:pipeline.sendGreeting(message.action)});
    else if(message.type==='PIPE_OPEN_RESUME')reply({ok:true,data:pipeline.openResume(message.action)});
    else if(message.type==='PIPE_PREPARE_RESUME')reply({ok:true,data:pipeline.prepareResume(message.action)});
    else if(message.type==='PIPE_SEND_RESUME')reply({ok:true,data:pipeline.sendResume(message.action)});
    else if(message.type==='PIPE_VERIFY')reply({ok:true,data:pipeline.verify(message.action,message.baseline)});
    else if(message.type==='PIPE_SYNC_VERIFY')reply({ok:true,data:pipeline.verify(message.action,message.action.baseline_ids,true)});
    else if(message.type==='PIPE_CANCEL'){pipeline.cancel();reply({ok:true,data:{cancelled:true}});}
    else reply({ok:false,error:'不支持的页面操作'});
  }catch(error){reply({ok:false,error:error.message});}
});
