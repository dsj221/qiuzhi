const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');

function harness(options={}){
  const calls=[],progress=[],nodes=new Map();
  const $=id=>{
    if(!nodes.has(id))nodes.set(id,{closest:()=>({open:false})});
    return nodes.get(id);
  };
  const account='已配对账号',item={id:'i',company:'公司',title:'岗位',source:'boss',resume_label:'简历.pdf'};
  const action={...item,account_label:account,send_resume:true,confirmation:options.personal?'personal':'automatic',direct_resume:!!options.personal,contact:'HR',trigger:'r',lease:'lease',message:'谢谢'};
  let tick;
  const api=async(type,data)=>{
    if(type==='FOLLOW_TARGETS')return {enabled:true,revision:'v',items:[item],account_label:account};
    if(type==='FOLLOW_SCAN')return {action:{...action},status:'发现新回复'};
    if(type==='FOLLOW_PROGRESS'){progress.push(data);if(options.cancel&&data.stage==='resume'&&data.outcome==='check')throw Error('设置已关闭');return {};}
    throw Error(type);
  };
  const page=async(type,{action}={})=>{
    calls.push(type);
    if(type==='PIPE_ACCOUNT')return {account_label:options.other?'其他':account};
    if(type==='PIPE_TARGET')return {message_ids:['r','g']};
    if(type==='PIPE_SELECT_CHAT')return {};
    if(type==='FOLLOW_READ')return {contact:'HR',messages:[{id:'r',role:'recruiter'}]};
    if(type==='PIPE_OPEN_RESUME'&&options.unverified)throw Error('简历选择器尚未完成现场诊断');
    if(type.includes('PREPARE'))return {message_ids:['r']};
    if(type==='PIPE_VERIFY'){
      if(action.mode==='greeting')return {receipt_key:'g',evidence:'谢谢',outcome:options.unknown?'UNKNOWN':'COMMUNICATING'};
      return {receipt_key:'f',evidence:'简历.pdf 已发送',outcome:'RESUME_SENT'};
    }
    return {};
  };
  const context={window:{addEventListener(){}},$,profile:{},api,page,Date,fetch:async()=>({json:async()=>({})}),
    setTimeout:f=>f(),setInterval:f=>{tick=f;},navigator:{locks:{request:async(_,__,f)=>f(true)}},
    chrome:{runtime:{getURL:()=>'',onMessage:{addListener(){}}},tabs:{query:async()=>[{id:123,url:'https://www.zhipin.com/web/geek/chat'}]},
      windows:{getCurrent:async()=>({focused:true})}}};
  vm.runInNewContext(fs.readFileSync('extension/reply-scanner.js','utf8'),context);
  vm.runInNewContext(fs.readFileSync('extension/followup-panel.js','utf8'),context);
  context.window.startReplyMonitor(()=>false);
  return {calls,progress,tick};
}
test('checks receipt before opening the specific attachment, then records its separate result',async()=>{
  const h=harness();await h.tick();
  assert.ok(h.calls.indexOf('PIPE_VERIFY')<h.calls.indexOf('PIPE_OPEN_RESUME'));
  assert.deepEqual(h.progress.map(x=>[x.stage,x.outcome]),[['reply','check'],['reply','sent'],['resume','check'],['resume','sent']]);
  assert.equal(h.calls.filter(x=>x==='PIPE_SEND_RESUME').length,1);
});
test('an uncertain reply never triggers a file, unverified chooser never triggers file confirmation',async()=>{
  const h=harness({unknown:true});await h.tick();assert.ok(!h.calls.includes('PIPE_OPEN_RESUME'));assert.equal(h.progress.at(-1).outcome,'review');
  const f=harness({unverified:true});await f.tick();assert.ok(!f.calls.includes('PIPE_SEND_RESUME'));assert.equal(f.progress.at(-1).stage,'resume');
});
test('a changed account or disabled rule stops subsequent clicks',async()=>{
  const h=harness({other:true});await h.tick();assert.equal(h.calls.length,1);
  const f=harness({cancel:true});await f.tick();assert.ok(!f.calls.includes('PIPE_SEND_RESUME'));
});

test('personal confirmation opens the chat popover and leaves the final click to the candidate',async()=>{
  const h=harness({personal:true});await h.tick();
  assert.ok(h.calls.includes('PIPE_OPEN_RESUME'));
  assert.ok(!h.calls.includes('PIPE_SEND_RESUME'));
  assert.equal(h.progress.at(-1).personal_confirmation,true);
  assert.ok(!h.progress.some(p=>p.stage==='resume'&&p.outcome==='sent'));
});
