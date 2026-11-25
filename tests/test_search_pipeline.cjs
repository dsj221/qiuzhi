const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const urls = [
  'https://www.zhipin.com/web/geek/jobs?query=Python&city=101020100',
  'https://www.zhipin.com/web/geek/jobs?query=Python&city=101210100'
];
const job = id => ({external_id:id,title:'Python工程师',company:'模拟公司',description:'使用 Python 开发业务服务',url:`https://www.zhipin.com/job_detail/${id}.html`});

function harness(options = {}) {
  const nodes = new Map(), calls = [], navigations = [], collected = [], listeners = [];
  const node = selector => {
    if(!nodes.has(selector))nodes.set(selector,{textContent:'',value:'',disabled:false,hidden:false,replaceChildren(){}});
    return nodes.get(selector);
  };
  let url = urls[0], selected = '', activeId = 7, tabReads = 0;
  const profile = {resumeChooserVerified:true};
  const items = [{id:'item1',batch_id:'batch',external_id:'one',company:'公司一',title:'Python工程师',search_url:urls[0]},
                 {id:'item2',batch_id:'batch',external_id:'two',company:'公司二',title:'Python工程师',search_url:urls[1]}];
  const settings = {preferences:{revision:3,limit:3},search_plan:{entries:urls.map(url=>({url,title:'Python',city:'模拟城市'})),total:2}};
  const context = {
    document:{querySelector:node}, window:{addEventListener(){}}, URL, profile, bound:null, stop(){}, jobs:async()=>{},
    Option:function(label,value){this.label=label;this.value=value;},
    setTimeout:fn=>{queueMicrotask(fn);return 1;},setInterval:()=>1,clearInterval(){},
    chrome:{tabs:{
      query:async()=>[{id:activeId}], get:async()=>{tabReads++;return {url,status:tabReads===1?'loading':'complete'};},
      update:async(id,change)=>{assert.equal(id,7);url=change.url;navigations.push(url);tabReads=0;},
      sendMessage:async()=>({}), onActivated:{addListener:fn=>listeners.push(fn)}
    }},
    api:async(type,data,id)=>{
      calls.push({type,data,id});
      if(options.api){const result=await options.api(type,data,id);if(result!==undefined)return result;}
      if(type==='SEARCH')return settings;
      if(type==='COLLECT'){collected.push(data);return {opportunities:[{screening:{result:'matched'}}]};}
      if(type==='APPLICATIONS')return {batches:[{id:'batch',mode:'resume',account_label:'本人账号'}],items};
      if(type==='APP_CLAIM')return {action:{...data.job,id:data.job.external_id,lease:'lease',mode:'resume',resume_label:'本人简历.pdf'}};
      if(type==='APP_PREFLIGHT')return {allowed:true};
      if(type==='APP_RESULT')return {batch_state:data.outcome==='UNKNOWN'?'NEEDS_REVIEW':'RUNNING'};
      return {};
    },
    page:async(type,data,expectedTabId)=>{
      assert.ok(expectedTabId===null||expectedTabId===undefined||expectedTabId===activeId);
      calls.push({type,data});
      if(options.page){const result=await options.page(type,data);if(result!==undefined)return {...result,tabId:7};}
      if(type==='PIPE_ACCOUNT')return {tabId:7,account_label:'本人账号'};
      if(type==='PIPE_LIST')return {tabId:7,account_label:'本人账号',list_url:url,jobs:(url===urls[0]?['one','shared']:['shared','two']).map(job)};
      if(type==='PIPE_SELECT'){selected=data.external_id;return {tabId:7};}
      if(type==='PIPE_CURRENT')return {tabId:7,account_label:'本人账号',job:job(selected)};
      if(type==='PIPE_OPEN')return {tabId:7,opened:true};
      if(type==='PIPE_TARGET')return {tabId:7,account_label:'本人账号',verified:true};
      if(type==='PIPE_PREPARE_RESUME')return {tabId:7,message_ids:['old'],resume_label:'本人简历.pdf'};
      if(type==='PIPE_VERIFY')return {tabId:7,outcome:'RESUME_SENT',receipt_key:selected,evidence:'本人简历.pdf 已发送'};
      return {tabId:7};
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../extension/pipeline-panel.js'),'utf8'),context);
  return {node,calls,navigations,collected,settings,items,profile,
    changeTab:()=>{activeId=8;listeners.forEach(fn=>fn({tabId:8}));},
    run:selector=>node(selector).onclick(),status:()=>node('#pipeline-status').textContent};
}

test('search visits each saved combination, waits for loading and deduplicates IDs',async()=>{
  const h=harness();await h.run('#search-jobs');
  assert.deepEqual(h.navigations,urls);
  assert.deepEqual(h.collected.map(d=>d.jobs[0].external_id),['one','shared','two']);
  assert.deepEqual(h.collected.map(d=>d.search_url),[urls[0],urls[0],urls[1]]);
  assert.ok(h.collected.every(d=>d.preferences_revision===3));
  assert.match(h.status(),/搜索完成.*3 个岗位/);
  assert.equal(h.node('#search-jobs').disabled,false);
  assert.equal(h.calls.some(c=>c.type==='APP_CLAIM'),false);
});

test('a real empty result advances to the next combination',async()=>{
  let reads=0;const h=harness({page(type){if(type==='PIPE_LIST'&&reads++===0)return {account_label:'本人账号',list_url:urls[0],jobs:[]};}});
  await h.run('#search-jobs');
  assert.deepEqual(h.navigations,urls);
  assert.equal(h.collected.length,2);
});

test('account change stops before importing jobs',async()=>{
  const h=harness({page(type){if(type==='PIPE_LIST')return {account_label:'其他账号',list_url:urls[0],jobs:[job('one')]};}});
  await h.run('#search-jobs');
  assert.equal(h.collected.length,0);assert.match(h.status(),/显示账号已变化/);
});

test('changed preferences stop the queue and do not proceed to another search',async()=>{
  const h=harness({api(type){if(type==='COLLECT')throw Error('筛选条件已更新，请重新启动搜索');}});
  await h.run('#search-jobs');
  assert.equal(h.navigations.length,1);assert.match(h.status(),/筛选条件已更新/);
});

test('a preference update is noticed before navigating to the next combination',async()=>{
  let reads=0;
  const h=harness({api(type){if(type==='SEARCH'&&reads++>0)return {preferences:{revision:4}};}});
  await h.run('#search-jobs');
  assert.equal(h.navigations.length,1);assert.match(h.status(),/筛选条件已更新/);
});

test('stopping during an asynchronous selection prevents collection',async()=>{
  let h;h=harness({async page(type){if(type==='PIPE_SELECT')await h.run('#stop-pipeline');}});
  await h.run('#search-jobs');
  assert.equal(h.collected.length,0);assert.equal(h.navigations.length,1);assert.match(h.status(),/任务已停止/);
});

test('leaving the active tab halts search before collection',async()=>{
  let h;h=harness({page(type){if(type==='PIPE_SELECT')h.changeTab();}});
  await h.run('#search-jobs');assert.equal(h.collected.length,0);assert.match(h.status(),/任务已停止/);
});

test('profile changes halt search before another page action',async()=>{
  let h;h=harness({page(type){if(type==='PIPE_SELECT')h.profile.titleSelector='.changed';}});
  await h.run('#search-jobs');assert.equal(h.collected.length,0);assert.match(h.status(),/配置已变化/);
});

test('untrusted search destinations cannot navigate the tab',async()=>{
  const h=harness();h.settings.search_plan.entries[0].url='https://evil.example/web/geek/jobs';
  await h.run('#search-jobs');assert.equal(h.navigations.length,0);assert.match(h.status(),/不是受支持/);
});

test('approved cross-city targets return to their own source lists before delivery',async()=>{
  const h=harness();h.node('#application-batch').value='batch';await h.run('#run-applications');
  assert.deepEqual(h.navigations,urls);
  assert.deepEqual(h.calls.filter(c=>c.type==='APP_CLAIM').map(c=>c.data.job.external_id),['one','two']);
  assert.equal(h.calls.filter(c=>c.type==='PIPE_SEND_RESUME').length,2);
  assert.equal(h.calls.filter(c=>c.type==='APP_RESULT'&&c.data.outcome==='RESUME_SENT').length,2);
  assert.match(h.status(),/批次处理结束/);
});

test('unknown receipt stops remaining targets without automatic retry',async()=>{
  const h=harness({page(type){if(type==='PIPE_VERIFY')return {outcome:'UNKNOWN'};}});
  h.node('#application-batch').value='batch';await h.run('#run-applications');
  assert.equal(h.navigations.length,1);assert.equal(h.calls.filter(c=>c.type==='PIPE_SEND_RESUME').length,1);
  assert.match(h.status(),/平台结果需要人工核对/);
});
