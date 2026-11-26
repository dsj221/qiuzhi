const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

test('drains the approved batch then returns the workflow tab to HR monitoring',async()=>{
  const nodes=new Map();
  const $=id=>{if(!nodes.has(id))nodes.set(id,{});return nodes.get(id);};
  let tab={id:12,url:'https://www.zhipin.com/web/geek/jobs',status:'complete'};
  let now=Date.now(),tick,approved=true,busy=true;
  class Clock extends Date {static now(){return now;}}
  const date=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'});
  const config={workflowVersion:2,connection:'pair',mode:'greeting',account:'本人',lastSearch:['v',date,'p','r'].join('/')};
  const events=[];
  const api=async(type)=>{
    if(type==='STATUS')return {connection_id:'pair'};
    if(type==='APPLICATIONS')return {batches:approved?[{id:'batch',account_label:'本人',automatic:true,state:'APPROVED'}]:[]};
    if(type==='APP_DISPATCH'){events.push(type);return {};}
    if(type==='SEARCH')return {resume_revision:'r',preferences:{revision:'p'},matching_version:'v',search_plan:{entries:[{}]}};
    if(type==='FOLLOW_TARGETS')return {enabled:true,account_label:'本人',items:[],threads:[]};
    throw Error(type);
  };
  const page=async(type)=>{
    if(type==='PIPE_ACCOUNT')return {account_label:'本人'};
    if(type==='INSPECT')return {path:'/web/geek/jobs'};
    throw Error(type);
  };
  const chrome={windows:{getCurrent:async()=>({focused:true})},tabs:{query:async()=>[tab],
    update:async(id,{url})=>{assert.equal(id,12);tab={...tab,url};events.push('chat');}},
    storage:{local:{get:async()=>({jobAutomation:config})},onChanged:{addListener(){}}}};
  const ctx={navigator:{locks:{request:async(_,__,fn)=>fn(true)}},window:{addEventListener(){}},chrome,api,page,$,URL,Date:Clock,setInterval:fn=>{tick=fn;}};
  vm.runInNewContext(fs.readFileSync('extension/automation.js','utf8'),ctx);
  const control=ctx.window.startJobAutomation({occupied:()=>false,begin:async fn=>{if(!busy){await fn(1);return true;}},
    executeBatch:async()=>{events.push('greeting');approved=false;}});
  await new Promise(setImmediate);
  async function cycle(){now+=6000;tick();await new Promise(setImmediate);}
  await cycle();assert.deepEqual(events,[]);
  busy=false;await cycle();await cycle();
  assert.deepEqual(events,['APP_DISPATCH','greeting','chat']);
  assert.equal(control.ownsInbox(12),true);
  assert.equal(control.ownsInbox(13),false);
});

test('the search step replaces a prior batch error with the current screening status and failure',async()=>{
  const nodes=new Map();
  const $=id=>{if(!nodes.has(id))nodes.set(id,{});return nodes.get(id);};
  $('#step-batch').textContent='上次发送时被遮挡';
  const tab={id:12,url:'https://www.zhipin.com/web/geek/jobs',status:'complete'};
  const saved={workflowVersion:2,connection:'pair',mode:'greeting',account:'本人',lastSearch:''};
  const settings={resume_revision:'r',preferences:{revision:1},search_plan:{entries:[{}]}};
  const api=async type=>({STATUS:{connection_id:'pair'},APPLICATIONS:{batches:[]},SEARCH:settings,FOLLOW_TARGETS:{threads:[]}})[type];
  const page=async type=>{if(type==='PIPE_ACCOUNT')return {account_label:'本人'};if(type==='INSPECT')return {path:'/web/geek/jobs'};throw Error('详情加载中');};
  let tick;
  const ctx={navigator:{locks:{request:async(_,__,fn)=>fn(true)}},window:{addEventListener(){}},chrome:{
    windows:{getCurrent:async()=>({focused:true})},tabs:{query:async()=>[tab]},
    storage:{local:{get:async()=>({jobAutomation:saved}),remove:async()=>{}},onChanged:{addListener(){}}}
  },api,page,$,URL,Date,importStatus(){},setInterval:fn=>{tick=fn;}};
  vm.runInNewContext(fs.readFileSync('extension/automation.js','utf8'),ctx);
  const message='已停止：工作台未能与模型接口建立连接，请检查网络或代理';
  ctx.window.startJobAutomation({occupied:()=>false,halt:async()=>{},status:text=>{$('#pipeline-status').textContent=text;},
    begin:async fn=>{try{await fn(1);return true;}catch(error){$('#pipeline-status').textContent='已停止：'+error.message;return false;}},
    search:async(_op,_settings,_tab,_account,progress)=>{
      progress('重试当前岗位');
      assert.equal($('#step-batch').textContent,'重试当前岗位');
      assert.equal($('#automation-status').textContent,'重试当前岗位');
      throw Error('工作台未能与模型接口建立连接，请检查网络或代理');
    }});
  await new Promise(setImmediate);
  tick();await new Promise(setImmediate);
  assert.equal($('#step-batch').textContent,message);
  assert.equal($('#automation-status').textContent,'自动搜索暂停。'+message);
});
