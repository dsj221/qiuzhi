const assert = require('node:assert/strict');
const path = require('node:path');
const {test} = require('node:test');
const {chromium} = require('playwright');
const profile = require('../extension/fixture-profile.json');

test('incoming badges wake the scanner and route each reply to its verified recruiter once', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    // Route the entire site locally so no real recruiter or model receives traffic.
    await page.route('**/*', route => route.fulfill({contentType:'text/html; charset=utf-8',body:`
      <div id="fixture-account"><h1>模拟账号</h1></div>
      <div class="user-list-content"><ul></ul></div>
      <div id="fixture-target-title"></div><div id="fixture-target-company"></div>
      <div id="fixture-messages"></div>
      <div id="fixture-editor"><textarea id="fixture-input"></textarea><button>发送</button></div>`}));
    await page.goto('https://www.zhipin.com/web/geek/chat');
    await page.evaluate(p => {
      window.wakes=[];window.receipts=[];window.switches=[];window.statuses=[];
      window.chrome={runtime:{id:'fixture',getURL:()=>'/profile',onMessage:{addListener(fn){window.listener=fn;}},
        sendMessage:async msg=>window.wakes.push(msg.reason)}};
      window.fetch=async()=>({json:async()=>p});
      window.addContact=(key,badge,prepend=false)=>{
        const row=document.createElement('li');
        row.innerHTML='<div class="friend-content"><div class="figure"></div><div class="title-box"><span class="name-box"><span class="name-text"></span></span><span class="company"></span></div><span class="time">昨天</span><span class="last-msg-text">请问方便沟通吗？</span></div>';
        const name='招聘方'+key,company='公司'+key;
        row.dataset.uid=key;
        row.querySelector('.name-text').textContent=name;
        row.querySelector('.company').textContent=company;
        if(badge)row.querySelector('.figure').innerHTML='<span class="notice-badge">1</span>';
        row.querySelector('.friend-content').onclick=()=>{
          window.switches.push(key);
          row.querySelector('.notice-badge')?.remove();
          document.querySelector('#fixture-target-title').textContent='模拟岗位';
          document.querySelector('#fixture-target-company').innerHTML='<div>'+name+'</div><div>'+company+'</div>';
          document.querySelector('#fixture-messages').innerHTML='<div class="fixture-message from-recruiter" data-message-id="incoming-'+key+'"><span class="message-text">请问方便沟通吗？</span></div>';
        };
        document.querySelector('ul')[prepend?'prepend':'append'](row);
      };
      window.addContact('历史',true);
      document.querySelector('button').onclick=()=>{
        const box=document.querySelector('textarea'),key=window.switches.at(-1);
        const row=document.createElement('div');row.className='fixture-message from-me';row.dataset.messageId='reply-'+key;
        const text=document.createElement('span');text.className='message-text';text.textContent=box.value;
        row.append(text);document.querySelector('#fixture-messages').append(row);box.value='';
      };
    },profile);
    for(const script of ['boss-adapter.js','pipeline-adapter.js','content.js','reply-scanner.js']){
      await page.addScriptTag({path:path.resolve(__dirname,'../extension',script)});
    }
    await page.evaluate(()=>{
      const scan=createReplyScanner({
        getProfile:async()=>({}), check(){},monitor(){},report:msg=>window.statuses.push(msg),
        page:(type,extra)=>new Promise((resolve,reject)=>window.listener({type,...extra},{id:'fixture'},response=>
          response.ok?resolve(response.data):reject(Error(response.error)))),
        api:async(type,data)=>{
          if(type==='FOLLOW_TARGETS')return {enabled:true,current_chat:true,opened_history:true,items:[],account_label:'模拟账号',revision:'v1'};
          if(type==='FOLLOW_PROGRESS'){
            if(data.outcome==='sent')window.receipts.push(data.receipt_key);
            return {};
          }
          if(type!=='FOLLOW_CURRENT')throw Error(type);
          const trigger=data.messages.at(-1);
          if(trigger.role!=='recruiter'||data.drafting)return {status:'等待来信'};
          return {status:'新来信',action:{id:trigger.id,trigger:trigger.id,account_label:data.account_label,
            title:data.title,company:data.company,contact:data.contact,expires_at:Date.now()/1000+60,
            lease:'测试',message:'您好，方便沟通。',send_resume:false}};
        }});
      window.tick=reason=>scan({id:1},false,reason);
    });
    await page.evaluate(()=>tick());
    await page.evaluate(()=>{
      document.querySelector('.time').textContent='上周';
      window.addContact('较早记录',true);
    });
    await page.evaluate(()=>tick());
    assert.deepEqual(await page.evaluate(()=>switches),[]);
    await page.evaluate(()=>{
      document.querySelector('textarea').value='我的草稿';
      addContact('乙',true,true);addContact('甲',true,true);
    });
    await page.waitForFunction(()=>wakes.includes('inbox'));
    await page.evaluate(()=>tick('inbox'));
    assert.deepEqual(await page.evaluate(()=>[switches,document.querySelector('textarea').value]),[[],'我的草稿']);
    await page.evaluate(()=>{document.querySelector('textarea').value='';});
    await page.evaluate(()=>tick('inbox'));
    await page.evaluate(()=>tick());
    await page.evaluate(()=>tick());
    assert.deepEqual(await page.evaluate(()=>switches),['甲','乙']);
    assert.deepEqual(await page.evaluate(()=>receipts),['reply-甲','reply-乙']);
  } finally {await browser.close();}
});
