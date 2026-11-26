const assert=require('node:assert/strict');
const {test}=require('node:test');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');

async function harness(){
  const nodes=new Map(),listeners={},requests=[];
  const field=()=>({value:'',checked:false,addEventListener(){}});
  function node(selector){
    if(!nodes.has(selector))nodes.set(selector,{value:'',innerHTML:'',textContent:'',open:false,options:[],elements:{account_label:field()},
      classList:{add(){},remove(){}},contains:()=>false,replaceChildren(...children){this.options=children;},
      addEventListener(type,fn){listeners[selector+':'+type]=fn;},reset(){},showModal(){this.open=true;}});
    return nodes.get(selector);
  }
  for(const name of ['titles','cities','districts','require_all_keywords','required_keywords','excluded_companies','min_salary_k','limit','search_limit','min_score','min_coverage','accept_internship','accept_other_cities','auto_favorite'])node('#search-preferences-form').elements[name]=field();
  const old='a'.repeat(32),current='b'.repeat(32),revoked='c'.repeat(32);
  const connections=[{id:old,label:'我的账号',revoked:false},{id:current,label:'我的账号',revoked:false,labels:{account:'当前本人'}},{id:revoked,label:'我的账号',revoked:true}];
  const opportunity=(id,connection_id)=>({id,connection_id,title:'Python工程师',company:'测试公司',city:'上海',url:'https://www.zhipin.com/job_detail/'+id+'.html',screening:{result:'matched',report:null,requirements:[],reasons:[],excluded_reasons:[],review_reasons:[]}});
  const data={preferences:{titles:['Python'],cities:['上海'],required_keywords:[],excluded_companies:[],min_salary_k:null,limit:10,search_limit:5,min_score:50,min_coverage:.5,revision:1},
    opportunities:[opportunity('one',current),opportunity('two',old),opportunity('revoked',revoked)],has_resume:true};
  const context={fetch:async()=>({json:async()=>({})}),document:{querySelector:node,querySelectorAll:()=>[],activeElement:null,addEventListener:(type,fn)=>listeners[type]=fn},
    setInterval(){},window:{},view:'jobs',esc:String,refresh:async()=>{},toast(){},
    Option:function(text,value){this.text=text;this.value=value;},
    FormData:function(){return [['connection_id',node('#application-connection').value],['account_label','当前本人'],['mode','greeting']];},
    api:async(url,method,body)=>{
      if(url==='/api/opportunities')return data;
      if(url==='/api/boss')return {connections};
      if(url==='/api/applications'&&method==='POST'){requests.push(body);return {batch:{account_label:'当前本人',mode:'greeting'},items:[]};}
      if(url==='/api/applications')return {batches:[],items:[]};
      throw Error('Unexpected API '+url);
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/job_agent/static/opportunities.js'),'utf8'),context);
  await new Promise(resolve=>setImmediate(resolve));
  return {node,requests,old,current,listeners,pick:(id,checked=true)=>listeners.change({target:{dataset:{pickOpportunity:id},checked}}),
    async submit(){listeners['#application-batch-form:submit']({preventDefault(){},target:node('#application-batch-form')});await new Promise(resolve=>setImmediate(resolve));}};
}

test('same-name connections are distinguishable and picking chooses the source connection',async()=>{
  const h=await harness();
  const labels=h.node('#application-connection').options.slice(1).map(o=>o.text);
  assert.equal(new Set(labels).size,2);
  h.node('#application-connection').value=h.old;h.pick('one');
  assert.equal(h.node('#application-connection').value,h.current);
  assert.equal(h.node('#application-batch-form').elements.account_label.value,'当前本人');
});

test('batch preview uses the picked source even if a stale connection was selected',async()=>{
  const h=await harness();h.pick('one');h.node('#application-connection').value=h.old;
  await h.submit();assert.equal(h.requests.length,1);assert.equal(h.requests[0].connection_id,h.current);
  assert.equal(h.node('#application-review').open,true);
});

test('mixed source connections fail before creating a batch',async()=>{
  const h=await harness();h.pick('one');h.pick('two');await h.submit();
  assert.equal(h.requests.length,0);assert.match(h.node('#error').textContent,/按采集连接分批/);
});

test('revoked source connections cannot create a batch',async()=>{
  const h=await harness();h.pick('revoked');await h.submit();
  assert.equal(h.requests.length,0);assert.match(h.node('#error').textContent,/连接已失效/);
});
