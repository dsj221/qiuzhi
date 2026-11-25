/* Run the extension worker against an in-memory browser/API harness, without opening BOSS. */
const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');

function harness(options={}){
  const nodes=new Map(),calls=[],listeners={};
  function node(id){if(!nodes.has(id))nodes.set(id,{textContent:'',value:id==='#application-batch'?'batch-1':'',replaceChildren(){},disabled:false});return nodes.get(id);}
  const batch={id:'batch-1',mode:options.mode||'greeting',account_label:'本人账号'};
  const targets=[1,2].map(i=>({id:'item-'+i,batch_id:batch.id,external_id:'role-'+i,title:'Python工程师'+i,company:'虚构公司'+i,state:'PENDING'}));
  let selected=targets[0],context;
  const api=async(type,data={},id)=>{
    calls.push([type,data,id]);
    if(type==='APPLICATIONS')return {batches:[batch],items:targets};
    if(type==='APP_CLAIM')return {action:{...selected,lease:'test-lease',account_label:batch.account_label,mode:batch.mode,message:'本人已核对的招呼',resume_label:'本人简历.pdf',expires_at:Date.now()/1000+60}};
    if(type==='APP_PREFLIGHT'){if(options.cancelBeforeSend&&data.stage==='send_greeting')await node('#stop-pipeline').onclick();return {allowed:true};}
    if(type==='APP_RESULT')return {batch_state:data.outcome==='UNKNOWN'?'NEEDS_REVIEW':'RUNNING'};
    if(type==='APP_STOP')return {ok:true};
    if(type==='APP_RECEIPTS')return {items:[{...targets[0],account_label:batch.account_label,mode:'resume',resume_label:'本人简历.pdf',baseline_ids:['old']}]};
    if(type==='APP_SYNC')return {ok:true};
    if(type==='SEARCH')return {preferences:{revision:1,limit:2}};
    if(type==='COLLECT')return {opportunities:[{screening:{result:'matched'}}]};
    throw Error('Unexpected API '+type);
  };
  const page=async(type,data={})=>{
    calls.push([type,data]);
    if(type==='PIPE_ACCOUNT')return {tabId:123,account_label:options.wrongAccount?'其他账号':batch.account_label};
    if(type==='PIPE_LIST')return {tabId:123,list_url:'http://127.0.0.1:8766/boss-fixture',account_label:options.wrongAccount?'其他账号':batch.account_label,jobs:targets};
    if(type==='PIPE_SELECT'){selected=targets.find(i=>i.external_id===data.external_id);return {selected:true};}
    if(type==='PIPE_CURRENT')return {tabId:123,account_label:batch.account_label,job:selected};
    if(type==='PIPE_OPEN'){if(options.openLost)throw Error('页面操作后连接断开');return {opened:true};}
    if(type==='PIPE_TARGET')return {verified:true,account_label:batch.account_label,message_ids:['old']};
    if(type==='PIPE_PREPARE_GREETING')return {prepared:true,message_ids:['old']};
    if(type==='PIPE_PREPARE_RESUME')return {prepared:true,message_ids:['old'],resume_label:'本人简历.pdf'};
    if(type==='PIPE_SEND_GREETING'||type==='PIPE_OPEN_RESUME'||type==='PIPE_SEND_RESUME')return {clicked:true};
    if(type==='PIPE_VERIFY')return {outcome:batch.mode==='greeting'?'COMMUNICATING':'RESUME_SENT',receipt_key:'new-'+selected.id,evidence:batch.mode==='greeting'?'本人已核对的招呼':'本人简历.pdf 已发送给BOSS'};
    if(type==='PIPE_SYNC_VERIFY')return {outcome:'RESUME_SENT',receipt_key:'later-receipt',evidence:'本人简历.pdf 已发送给BOSS'};
    throw Error('Unexpected page '+type);
  };
  context=vm.createContext({URL,document:{querySelector:node},window:{addEventListener:(type,fn)=>{listeners[type]=fn;}},Option:function(){},profile:{resumeChooserVerified:options.verified!==false},api,page,stop(){},bound:null,jobs:async()=>{},setTimeout:fn=>{queueMicrotask(fn);},setInterval:()=>1,clearInterval(){},chrome:{tabs:{query:async()=>[{id:123}],get:async()=>({status:'complete',url:'http://127.0.0.1:8766/boss-fixture'}),update:async()=>{},sendMessage:async()=>({}),onActivated:{addListener:fn=>{listeners.tabActivated=fn;}}}}});
  vm.runInContext(fs.readFileSync('extension/pipeline-panel.js','utf8'),context);
  return {calls,node,listeners,run:()=>node('#run-applications').onclick(),collect:()=>node('#collect-jobs').onclick()};
}

test('a reviewed batch executes sequentially and reports each new receipt',async()=>{
  const h=harness();await h.run();
  assert.equal(h.calls.filter(c=>c[0]==='APP_CLAIM').length,2);
  assert.equal(h.calls.filter(c=>c[0]==='PIPE_SEND_GREETING').length,2);
  assert.deepEqual(h.calls.filter(c=>c[0]==='APP_RESULT').map(c=>c[1].outcome),['COMMUNICATING','COMMUNICATING']);
  assert.match(h.node('#pipeline-status').textContent,/批次处理结束/);
});
test('a lost response after opening communication is unknown and stops the batch',async()=>{
  const h=harness({openLost:true});await h.run();
  assert.deepEqual(h.calls.filter(c=>c[0]==='APP_RESULT').map(c=>c[1].outcome),['UNKNOWN']);
  assert.equal(h.calls.filter(c=>c[0]==='APP_CLAIM').length,1);
  assert.equal(h.calls.filter(c=>c[0]==='PIPE_SEND_GREETING').length,0);
});
test('cancelling during preflight prevents the subsequent send',async()=>{
  const h=harness({cancelBeforeSend:true});await h.run();
  assert.equal(h.calls.filter(c=>c[0]==='APP_STOP').length,1);
  assert.equal(h.calls.filter(c=>c[0]==='PIPE_SEND_GREETING').length,0);
  assert.equal(h.calls.filter(c=>c[0]==='APP_RESULT')[0][1].outcome,'UNKNOWN');
});
test('unverified resume selector stops before touching the target page',async()=>{
  const h=harness({mode:'resume',verified:false});await h.run();
  assert.equal(h.calls.filter(c=>c[0].startsWith('PIPE_')).length,0);
  assert.match(h.node('#pipeline-status').textContent,/尚未完成现场诊断/);
});
test('the confirmed file name and baseline are carried into resume preflight',async()=>{
  const h=harness({mode:'resume'});await h.run();
  const checks=h.calls.filter(c=>c[0]==='APP_PREFLIGHT'&&c[1].stage==='send_resume');
  assert.equal(checks.length,2);
  assert.ok(checks.every(c=>c[1].resume_label==='本人简历.pdf'&&c[1].message_ids[0]==='old'));
  assert.ok(h.calls.filter(c=>c[0]==='APP_RESULT').every(c=>c[1].outcome==='RESUME_SENT'));
});
test('a different displayed account cannot claim or send jobs',async()=>{
  const h=harness({wrongAccount:true});await h.run();
  assert.equal(h.calls.filter(c=>c[0]==='APP_CLAIM').length,0);
});
test('collection reads each selected job and uses saved preferences',async()=>{
  const h=harness();await h.collect();
  assert.equal(h.calls.filter(c=>c[0]==='COLLECT').length,2);
  assert.match(h.node('#pipeline-status').textContent,/2 个符合条件/);
});
test('later receipt synchronization never claims, fills or sends another application',async()=>{
  const h=harness();await h.node('#sync-application-receipts').onclick();
  assert.equal(h.calls.filter(c=>c[0]==='APP_SYNC').length,1);
  assert.equal(h.calls.filter(c=>/CLAIM|SEND|PREPARE|OPEN/.test(c[0])).length,0);
});
