const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');

function control(covered=false,disabled=false){
  let clicks=0;
  const button={disabled,scrollIntoView(){},getAttribute(){return null;},getBoundingClientRect(){return {left:10,top:10,width:100,height:30};},contains(node){return node===this;},click(){clicks++;}};
  const doc={elementFromPoint:()=>covered?{}:button};
  const context=vm.createContext({JobPageAdapter:class{guard(){}visible(){return true;}}});
  vm.runInContext(fs.readFileSync('src/job_agent/static/pipeline-adapter.js','utf8'),context);
  const adapter=Object.create(context.JobPipelineAdapter.prototype);adapter.doc=doc;
  return {adapter,button,clicks:()=>clicks};
}
test('covered controls cannot send behind a verification overlay',()=>{
  const h=control(true);assert.throws(()=>h.adapter.activate(h.button),/遮挡/);assert.equal(h.clicks(),0);
});
test('disabled controls are not activated',()=>{
  const h=control(false,true);assert.throws(()=>h.adapter.activate(h.button),/失效/);assert.equal(h.clicks(),0);
});
test('only the exposed enabled control is activated',()=>{
  const h=control();h.adapter.activate(h.button);assert.equal(h.clicks(),1);
});
