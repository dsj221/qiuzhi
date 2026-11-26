'use strict';

function createReplyScanner({api,page,getProfile,check,report,monitor}){
  const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const realProfile=fetch(chrome.runtime.getURL('boss-chat-profile.json')).then(r=>r.json());
  let cursor=0,nextRotation=0;
  return async function inspect(tab,fixture,reason,workflow=false){
    const plan=await api('FOLLOW_TARGETS');
    monitor(null);
    if(!plan.enabled){report('在工作台「HR 回复跟进」开启后开始监听。');return;}
    const items=plan.items.filter(i=>(i.source==='fixture')===fixture);
    if(!fixture){
      const isBatch=t=>items.some(i=>i.source!=='manual_chat'&&i.title===t.title&&i.company===t.company);
      items.push(...(plan.threads||[]).filter(t=>!isBatch(t)));
    }
    if(!items.length&&!plan.current_chat){report('等待已确认打过招呼的岗位。');return;}
    const profile=await getProfile();
    if(fixture&&profile.jobSelector!=='#fixture-job')throw Error('本机模拟页需要模拟配置');
    const p=fixture?profile:{...await realProfile,...(profile.jobSelector==='#fixture-job'?{}:profile)};
    const call=(type,extra={})=>{check();return page(type,{profile:p,...extra},tab.id);};
    const account=await call('PIPE_ACCOUNT');
    if(account.account_label!==plan.account_label)throw Error('当前账号与跟进设置不符');
    monitor(tab.id);
    let item,snapshot,manual=false;
    const catchUp=reason==='catch_up';
    if(catchUp&&!plan.current_chat)throw Error('当前工作台尚未加载手动会话跟进，请重启本机服务');
    const opened=!fixture&&plan.current_chat;
    let drafting=false;
    if(opened){
      if(!plan.opened_history)throw Error('请重启工作台以启用当前会话历史保存');
      const context={items:items.map(({id,title,company,contact})=>({id,title,company,contact})),
        action:{account_label:plan.account_label,revision:plan.revision,expires_at:Date.now()/1000+90}};
      const unread=!catchUp&&reason!=='chat'?await call('FOLLOW_OPEN_UNREAD',{action:context.action}):{};
      if(unread.waiting){report(unread.waiting);return;}
      let first;
      if(unread.labels){
        report('收到新消息，正在核对招聘方和聊天记录');
        for(let attempt=0;attempt<8;attempt++){
          await delay(250);
          try{first=await call('FOLLOW_OPEN_CHAT',context);}
          catch(error){if(error.message!=='尚无可核对的聊天记录')throw error;}
          const name=first?.snapshot?.contact.split('\n')[0];
          if(name===unread.name&&unread.labels.includes(first.company)&&
              first.snapshot.messages.at(-1)?.role==='recruiter')break;
          first=null;
        }
        if(!first){report('未能核对新消息的招聘方和聊天记录');return;}
      }else{
        try{first=await call('FOLLOW_OPEN_CHAT',context);}
        catch(error){
          if(error.message!=='尚无可核对的聊天记录')throw error;
          report('正在监听联系人列表，等待新来信。');return;
        }
      }
      if(first.waiting){report(first.waiting);return;}
      if(workflow&&items.length&&!catchUp&&!first.drafting&&!first.snapshot&&Date.now()>=nextRotation){
        nextRotation=Date.now()+10000;
        const hinted=reason==='inbox'?await call('FOLLOW_HINT',{reason,items:context.items}):null;
        const next=items.find(i=>hinted?.id===i.id)||items[cursor++%items.length];
        if(first.id!==next.id){
          await call('PIPE_SELECT_CHAT',{action:{...next,...context.action,follow_target:true}});
          for(let attempt=0;attempt<8;attempt++){
            await delay(250);
            first=await call('FOLLOW_OPEN_CHAT',context);
            if(first.id===next.id)break;
          }
          if(first.id!==next.id){report('等待核对所选岗位的聊天记录');return;}
        }
      }
      if(!first.snapshot){report('正在监听联系人列表，等待新来信。');return;}
      await delay(300);
      const current=await call('FOLLOW_OPEN_CHAT',context);
      if(!current.snapshot||first.snapshot.contact!==current.snapshot.contact||first.title!==current.title||
          first.snapshot.messages.at(-1).id!==current.snapshot.messages.at(-1).id){
        report('会话正在更新，稍后重新读取。');return;
      }
      item=current.id?items.find(i=>i.id===current.id):{title:current.title,company:current.company};
      if(!item)return;
      snapshot=current.snapshot;manual=!current.id||item.source==='manual_chat';drafting=current.drafting;
      report(item.company+' · '+item.title+' · 正在检查当前会话');
    }
    if(!manual&&catchUp){report('请选择已有本人消息的手动沟通会话。');return;}
    if(!manual&&!items.length)return;
    if(!manual&&!item&&reason){
      const hint=await call('FOLLOW_HINT',{reason,items:items.map(({id,company,title})=>({id,company,title}))});
      item=items.find(i=>i.id===hint.id);
      if(!item)return;
    }else if(!manual&&!item)item=items[cursor++%items.length];
    const target={...item,account_label:plan.account_label,expires_at:Date.now()/1000+90};
    // Selecting an existing conversation never uses the initial contact button.
    if(!snapshot)await call('PIPE_SELECT_CHAT',{action:{...target,follow_target:true}});
    for(let i=0;!snapshot&&i<8;i++){
      try{snapshot=await call('FOLLOW_READ',{action:target});break;}
      catch(e){if(i===7||!/岗位或公司|尚无可核对/.test(e.message))throw e;await delay(300);}
    }
    const result=await api(manual?'FOLLOW_CURRENT':'FOLLOW_SCAN',{...(manual?{title:item.title,company:item.company,catch_up:catchUp}:{item_id:item.id}),opened_chat:!!opened,drafting,revision:plan.revision,account_label:plan.account_label,
      contact:snapshot.contact,messages:snapshot.messages,resume_seen:snapshot.resume_seen,
      delivered_id:snapshot.delivered_id,delivered_evidence:snapshot.delivered_evidence});
    report(item.company+' · '+item.title+' · '+result.status);
    if(!result.action)return;
    const action=result.action;
    if(action.direct_resume===undefined)action.direct_resume=!action.resume_label;
    let stage='reply';
    const progress=(outcome,extra={})=>api('FOLLOW_PROGRESS',{item_id:action.id,lease:action.lease,stage,outcome,...extra});
    async function receipt(action,baseline){
      for(let attempt=0;attempt<16;attempt++){
        await delay(300);
        const result=await call('PIPE_VERIFY',{action,baseline});
        if(result.outcome!=='UNKNOWN')return result;
      }
      throw Error(action.direct_resume&&action.mode==='resume'?'已点击「确定」，附件发送结果待核对':'未读到新的平台回执，请在 BOSS 核对');
    }
    try{
      action.mode='greeting';
      const prepared=await call('PIPE_PREPARE_GREETING',{action});
      await progress('check');
      await call('PIPE_SEND_GREETING',{action});
      const reply=await receipt(action,prepared.message_ids);
      await progress('sent',{evidence:reply.evidence,receipt_key:reply.receipt_key});
      report(item.company+' · 已确认文字回复');
      if(catchUp||!action.send_resume)return;
      stage='resume';action.mode='resume';action.reply_id=reply.receipt_key;
      const personal=action.confirmation!=='automatic';
      if(personal){
        const target=await call('PIPE_TARGET',{action});
        await progress('check',{personal_confirmation:true,baseline_ids:target.message_ids});
      }
      await call('PIPE_OPEN_RESUME',{action});
      if(personal&&action.direct_resume){
        report(item.company+' · 请本人在 BOSS 点击「确定」发送附件');
        return;
      }
      let choice;
      for(let i=0;i<10;i++){
        try{choice=await call('PIPE_PREPARE_RESUME',{action});break;}
        catch(e){const waiting=e.message==='等待发简历确认框'||(e.message.startsWith('选择器应唯一匹配可见元素')&&e.message.endsWith('当前 0 个'));
          if(i===9||!waiting)throw e;await delay(250);}
      }
      if(personal){
        report(item.company+' · 已选中指定文件，请本人确认发送');
        return;
      }
      await progress('check',{baseline_ids:choice.message_ids});
      await call('PIPE_SEND_RESUME',{action});
      const file=await receipt(action,choice.message_ids);
      await progress(file.outcome==='RESUME_SENT'?'sent':'requested',{evidence:file.evidence,receipt_key:file.receipt_key});
      report(item.company+(file.outcome==='RESUME_SENT'?' · 已核对附件发送回执':' · 平台显示简历请求已发送'));
    }catch(e){
      await progress('review',{reason:e.message.slice(0,500)}).catch(()=>{});
      throw e;
    }
  }
}
