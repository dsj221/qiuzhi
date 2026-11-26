const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const script=fs.readFileSync('src/job_agent/static/followups.js','utf8');

function open(store,settings,failSave=false){
  const nodes=new Map(),fields={};
  function node(name){
    return {name,value:'',textContent:'',children:[],listeners:{},
      addEventListener(e,fn){this.listeners[e]=fn;},
      replaceChildren(...children){this.children=children;this.value=children[0]?.value||'';},
      append(child){this.children.push(child);}};
  }
  function q(key){if(!nodes.has(key))nodes.set(key,node(key));return nodes.get(key);}
  for(const k of ['account_label','message','later_message','reply_mode','confirmation','resume_label','connection','enabled','webhook','secret'])fields[k]=node(k);
  const form=q('#followup-form');
  form.elements=fields;form.querySelector=q;form.querySelectorAll=()=>[];
  q('#followup-settings').open=true;
  let sent=0;
  const api=async(path,method='GET',body)=>{
    if(path==='/api/boss')return {connections:[{id:'other',label:'账号'},{id:'contacted',label:'账号',auto_greeting_account:'本人'}]};
    const id=path.split('/')[4];
    if(method==='PUT'){
      if(failSave)throw new TypeError('Failed to fetch');
      for(const k of ['message','account_label','resume_label','enabled'])settings[id][k]=body[k];
      if(body.webhook)settings[id].webhook_configured=true;
    }
    if(method==='POST')sent++;
    return settings[id];
  };
  const localStorage={getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)};
  vm.runInNewContext(script,{document:{querySelector:q,createElement:node},localStorage,TypeError,api,Option:function(text,value){this.value=value;}});
  return {q,fields,form,get sent(){return sent;},ready:()=>new Promise(resolve=>setImmediate(resolve))};
}
test('refresh restores the selected connection and its own ordinary draft, without persisting credentials',async()=>{
  const store=new Map();
  const rule=()=>({account_label:'本人',message:'原回复',resume_label:'',enabled:false,events:[],actions:[],webhook_configured:true});
  const settings={contacted:rule(),other:rule()};
  let p=open(store,settings);await p.ready();
  assert.equal(p.fields.connection.value,'contacted');
  p.fields.connection.value='other';await p.fields.connection.onchange();
  p.fields.resume_label.value='我的简历.pdf';
  p.form.listeners.input({target:p.fields.resume_label});
  p.fields.secret.value='sensitive-example';p.form.listeners.input({target:p.fields.secret});
  assert.ok(![...store.values()].join('').includes('sensitive-example'));
  p=open(store,settings,true);await p.ready();
  assert.equal(p.fields.connection.value,'other');assert.equal(p.fields.resume_label.value,'我的简历.pdf');
  await p.form.onsubmit({preventDefault(){}});
  assert.match(p.q('#followup-feedback').textContent,/8766/);
  assert.equal(p.fields.resume_label.value,'我的简历.pdf');
  p.fields.connection.value='contacted';await p.fields.connection.onchange();assert.equal(p.fields.resume_label.value,'');
  p.fields.connection.value='other';await p.fields.connection.onchange();
  p.fields.webhook.value='unsaved';await p.q('#followup-test').onclick();assert.equal(p.sent,0);
  p=open(store,settings);await p.ready();
  await p.form.onsubmit({preventDefault(){}});
  assert.equal(settings.other.resume_label,'我的简历.pdf');assert.ok(!store.has('job-agent.followup.draft.other'));
  assert.match(p.fields.webhook.placeholder,/无需重填/);
});
