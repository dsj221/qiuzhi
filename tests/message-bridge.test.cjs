const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

function bridge({missing=1,moved=false,problem='Could not establish connection. Receiving end does not exist.'}={}){
  let calls=0;
  const tab={id:7,active:true,url:'https://www.zhipin.com/web/geek/jobs'};
  async function deliver(){
    if(++calls<=missing)throw Error(problem);
    return {ok:true};
  }
  const chrome={runtime:{sendMessage:deliver},tabs:{sendMessage:deliver,get:async()=>({...tab,active:!moved})}};
  const ctx={chrome,setTimeout:f=>f()};
  vm.runInNewContext(fs.readFileSync('extension/message-bridge.js','utf8'),ctx);
  return {page:type=>ctx.tabMessage(tab,{type}),api:type=>ctx.backgroundMessage(type),calls:()=>calls};
}
test('reads reconnect to the same tab or worker',async()=>{
  for(const scope of ['page','api']){
    const b=bridge({missing:2});
    assert.equal((await b[scope](scope==='page'?'PIPE_ACCOUNT':'STATUS')).ok,true);
    assert.equal(b.calls(),3);
  }
});
test('changed tab and missing receiver are distinguishable; waits are bounded',async()=>{
  const a=bridge({moved:true});
  await assert.rejects(a.page('PIPE_LIST'),/标签页已变化/);
  assert.equal(a.calls(),1);
  const b=bridge({missing:50});
  await assert.rejects(b.page('FOLLOW_READ'),{name:'ReadReceiverUnavailable'});
  assert.equal(b.calls(),6);
});
test('sending, filing, dispatching and ambiguous closed channels are never replayed',async()=>{
  for(const type of ['PIPE_SEND_GREETING','PIPE_SEND_RESUME','APP_DISPATCH','FOLLOW_CURRENT','CREATE_LOCAL_PAIR']){
    const b=bridge();
    await assert.rejects(type.startsWith('PIPE')?b.page(type):b.api(type),{name:'ActionReceiverUnavailable'});
    assert.equal(b.calls(),1);
  }
  const b=bridge({problem:'The message port closed before a response was received.'});
  await assert.rejects(b.page('PIPE_ACCOUNT'),/port closed/);
  assert.equal(b.calls(),1);
});
