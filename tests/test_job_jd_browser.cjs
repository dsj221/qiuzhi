// Run with node tests/test_job_jd_browser.cjs (requires Playwright and Chromium).
const assert=require('node:assert/strict');
const path=require('node:path');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
const url='https://www.zhipin.com/job_detail/jd-role-1.html';
const html=`<div class="job-banner"><div class="name"><h1>Python工程师</h1></div><span class="text-city">上海</span></div>
  <div class="company-info"><div class="name"><a>虚构研发团队</a></div></div>
  <section class="job-detail-section"><div class="job-sec-text">岗位职责：使用 Python 开发业务服务，维护业务接口。<br>岗位要求：了解 SQL 和自动化测试，能说明项目职责。</div></section>`;
const key='a'.repeat(32);
(async()=>{
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage({viewport:{width:380,height:900}});
    await page.goto('file://'+path.join(root,'extension/panel.html'));
    // Parsing is independent of the extension runtime and never executes HTML scripts.
    const parsed=await page.evaluate(({html,url})=>{
      const doc=new DOMParser().parseFromString(html,'text/html');return JobJD.read(doc,url);
    },{html,url});
    assert.equal(parsed.title,'Python工程师');assert.equal(parsed.company,'虚构研发团队');
    assert.match(parsed.description,/\n岗位要求/);assert.equal(parsed.external_id,'jd-role-1');
    for(const [body,link] of [[html,'https://evil.example/job_detail/jd-role-1.html'],['<h1>登录 / 验证</h1>',url],[html+html,url]]){
      assert.equal(await page.evaluate(({body,link})=>{try{JobJD.read(new DOMParser().parseFromString(body,'text/html'),link);return false;}catch{return true;}},{body,link}),true);
    }
    await page.addInitScript(({html,url,key})=>{
      window.mock={calls:[],needs:true,mode:'fetch',html,url};
      window.chrome={storage:{local:{get:async()=>({profile:{captureMode:'snapshot'}}),set:async()=>{}}},
        tabs:{query:async()=>[{id:7,url:'https://www.zhipin.com/web/geek/chat'}],onActivated:{addListener:()=>{}},
          sendMessage:async(id,message)=>{
            if(message.type==='READ_JOB'&&mock.mode==='visible')return {ok:true,data:{external_id:'jd-role-1',title:'Python工程师',company:'虚构研发团队',city:'上海',description:'岗位职责：使用 Python 开发业务服务，维护业务接口，并编写单元测试。',url}};
            if(message.type==='READ_JOB_LINK')return {ok:true,data:{url}};
            if(['READ_CHAT','BIND_CHAT'].includes(message.type))return {ok:true,data:{capture_mode:'snapshot',binding:{account:'view:a',job:'view:a',conversation:'view:a'},labels:{position:'Python工程师',conversation:'招聘方\n虚构研发团队'},messages:[]}};
            return {ok:false,error:'没有展开详情'};
          }},
        runtime:{getURL:x=>x,sendMessage:async message=>{
          mock.calls.push(message);
          if(message.type==='STATUS')return {ok:true,data:{paired:true}};
          if(message.type==='JOBS')return {ok:true,data:{jobs:[{id:key,title:'Python工程师',company:'虚构研发团队',url:mock.savedURL||'',external_id:'jd-role-1',needs_jd:mock.needs}]}};
          if(message.type==='IMPORT_CHAT_JOB')return {ok:true,data:{job_id:key}};
          if(message.type==='OBSERVE')return {ok:true,data:{count:0}};
          if(message.type==='FETCH_JOB_HTML')return {ok:true,data:{html:mock.html,url}};
          if(message.type==='UPDATE_JOB_JD'){mock.needs=false;return {ok:true,data:{changed:true}};}
          return {ok:false,error:'未实现的测试操作'};
        }}};
    },{html,url,key});
    await page.reload();
    await page.locator('#job option[value="'+key+'"]').waitFor({state:'attached'});
    await page.selectOption('#job',key);
    await page.click('#fetch-job-jd');
    await page.waitForFunction(()=>document.querySelector('#jd-status').textContent.includes('完整 JD 已保存'));
    let calls=await page.evaluate(()=>mock.calls);
    assert.equal(calls.filter(c=>c.type==='UPDATE_JOB_JD').length,1);
    assert.equal(calls.find(c=>c.type==='UPDATE_JOB_JD').actionId,key);
    // Failure must leave the saved record alone and restore the retry control.
    await page.evaluate(()=>{mock.html=mock.html.replace('虚构研发团队','其他公司');mock.calls=[];});
    await page.click('#fetch-job-jd');
    await page.waitForFunction(()=>document.querySelector('#jd-status').textContent.includes('未覆盖原档案'));
    assert.equal(await page.evaluate(()=>mock.calls.some(c=>c.type==='UPDATE_JOB_JD')),false);
    assert.equal(await page.locator('#fetch-job-jd').isEnabled(),true);
    // Visible DOM is preferred; no HTML fetch is needed.
    await page.evaluate(()=>{mock.mode='visible';mock.calls=[];});
    await page.click('#fetch-job-jd');
    await page.waitForFunction(()=>document.querySelector('#jd-status').textContent.includes('完整 JD 已保存'));
    assert.equal(await page.evaluate(()=>mock.calls.some(c=>c.type==='FETCH_JOB_HTML')),false);
    // Another posting with identical labels must fall back to the selected URL.
    await page.evaluate(()=>{mock.mode='other';mock.savedURL=mock.url;mock.html=mock.html.replace('其他公司','虚构研发团队');mock.calls=[];
      const send=chrome.tabs.sendMessage;chrome.tabs.sendMessage=async(id,message)=>message.type==='READ_JOB'?{ok:true,data:{external_id:'other',title:'Python工程师',company:'虚构研发团队',description:'另一个岗位的Python职责与项目要求，需要说明具体项目经验。',url:mock.url.replace('jd-role-1','other')}}:send(id,message);
    });
    await page.click('#fetch-job-jd');
    await page.waitForFunction(()=>document.querySelector('#jd-status').textContent.includes('完整 JD 已保存'));
    assert.equal(await page.evaluate(()=>mock.calls.some(c=>c.type==='FETCH_JOB_HTML')),true);
    // Chat creation and binding automatically complete missing JD.
    await page.evaluate(()=>{mock.needs=true;mock.calls=[];});
    await page.check('#chat-consent');
    await page.click('#bind');
    await page.waitForFunction(()=>mock.calls.some(c=>c.type==='UPDATE_JOB_JD'));
    await page.waitForFunction(()=>!document.querySelector('#fetch-job-jd').disabled);
    await page.evaluate(()=>{mock.needs=true;mock.calls=[];});
    await page.locator('details:has(#preview-chat-job) > summary').click();
    await page.click('#preview-chat-job');
    await page.fill('#chat-job-title','Python工程师');await page.fill('#chat-job-company','虚构研发团队');
    await page.click('#create-chat-job');
    await page.waitForFunction(()=>mock.calls.some(c=>c.type==='UPDATE_JOB_JD'));
    await page.waitForFunction(()=>!document.querySelector('#fetch-job-jd').disabled);
    await page.uncheck('#auto-fetch-jd');
    await page.evaluate(()=>{mock.needs=true;mock.calls=[];});
    await page.click('#bind');
    await page.waitForFunction(()=>mock.calls.some(c=>c.type==='OBSERVE'));
    assert.equal(await page.evaluate(()=>mock.calls.some(c=>c.type==='UPDATE_JOB_JD')),false);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    assert.equal(await page.locator('#jd-status').getAttribute('aria-live'),'polite');
    await page.screenshot({path:path.join(root,'artifacts/jd-panel.png'),fullPage:true});
    console.log('Passed: JD parsing, invalid URLs/content, visible detail, fetch/save, wrong company, automatic create/bind, opt-out, narrow panel.');
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
