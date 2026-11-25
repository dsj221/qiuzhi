'use strict';
const $=s=>document.querySelector(s);
let counter=1;
function add(role,text){const el=document.createElement('article');el.className='fixture-message '+(role==='me'?'from-me':'from-recruiter');el.dataset.messageId='fixture-msg-'+(++counter);const span=document.createElement('span');span.className='message-text';span.textContent=text;el.append(span);$('#fixture-messages').append(el);}
$('#fixture-send').onclick=()=>{const text=$('#fixture-input').value.trim();if(text){add('me',text);$('#fixture-input').value='';}};
$('#fixture-add').onclick=()=>{const text=$('#fixture-reply').value.trim();if(text)add('recruiter',text);};
$('#fixture-switch').onclick=()=>{const chat=$('#fixture-chat');const name=chat.dataset.conversationId==='fixture-recruiter-A'?'B':'A';chat.dataset.conversationId='fixture-recruiter-'+name;chat.querySelector('h2').textContent='招聘方会话 '+name;$('#fixture-messages').replaceChildren();add('recruiter','这是会话 '+name+' 的新消息。');$('#fixture-input').value='';};
$('#fixture-verify').onclick=()=>{$('#fixture-blocked').hidden=!$('#fixture-blocked').hidden;};
$('#fixture-selftest').onclick=async()=>{
  const original={messages:$('#fixture-messages').innerHTML,input:$('#fixture-input').value,conversation:$('#fixture-chat').dataset.conversationId,blocked:$('#fixture-blocked').hidden};
  const results=[];
  try{
    const profile=await (await fetch('/static/fixture-profile.json')).json(), adapter=new JobPageAdapter(document,profile);
    const assert=(value,label)=>{if(!value)throw Error(label);results.push('✓ '+label);};
    const rejects=(fn,label)=>{let rejected=false;try{fn();}catch{rejected=true;}assert(rejected,label);};
    $('#fixture-blocked').hidden=true;$('#fixture-input').value='';
    const snapshot=adapter.chat();assert(adapter.job().description.length>20,'读取岗位标题、公司与正文');
    assert(snapshot.messages.every(m=>['me','recruiter'].includes(m.role)),'消息方向明确');
    const action={id:'selftest-1',binding:snapshot.binding,text:'这是本人确认后的测试草稿。'};
    adapter.fill(action,snapshot);assert($('#fixture-input').value===action.text,'草稿填入输入框');
    assert(adapter.chat().messages.length===snapshot.messages.length,'填入草稿不会发送消息');
    rejects(()=>adapter.fill(action,snapshot),'同一草稿不能重复填入');
    $('#fixture-input').value='人工草稿';rejects(()=>adapter.fill({...action,id:'selftest-2'},snapshot),'不覆盖人工草稿');
    $('#fixture-input').value='';$('#fixture-chat').dataset.conversationId='changed';rejects(()=>adapter.fill({...action,id:'selftest-3'},snapshot),'招聘方切换后禁止填入');
    $('#fixture-chat').dataset.conversationId=original.conversation;
    add('recruiter','新增消息');rejects(()=>adapter.fill({...action,id:'selftest-4'},snapshot),'新消息使旧草稿失效');
    $('#fixture-messages').innerHTML=original.messages;
    const message=$('#fixture-messages .fixture-message');message.classList.add('from-me','from-recruiter');rejects(()=>adapter.chat(),'消息方向混淆时停止');
    $('#fixture-messages').innerHTML=original.messages;
    const clone=$('#fixture-messages .fixture-message').cloneNode(true);$('#fixture-messages').append(clone);rejects(()=>adapter.chat(),'重复消息ID停止');
    $('#fixture-messages').innerHTML=original.messages;$('#fixture-blocked').hidden=false;rejects(()=>adapter.chat(),'出现验证提示停止');
    $('#fixture-tests').textContent=results.join('\n')+'\n全部通过。仅验证共享DOM适配器，不代表扩展安装或真实BOSS已接通。';
  }catch(error){$('#fixture-tests').textContent=results.join('\n')+'\n✗ '+error.message;}
  finally{$('#fixture-messages').innerHTML=original.messages;$('#fixture-input').value=original.input;$('#fixture-chat').dataset.conversationId=original.conversation;$('#fixture-blocked').hidden=original.blocked;}
};

$('#fixture-snapshot-test').onclick=async()=>{
  const original={messages:$('#fixture-messages').innerHTML,input:$('#fixture-input').value,heading:$('#fixture-chat h2').textContent,blocked:$('#fixture-blocked').hidden,classes:$('#fixture-chat').className};
  let adapter;const results=[];
  try{
    const profile=await (await fetch('/static/fixture-profile.json')).json();
    Object.assign(profile,{captureMode:'snapshot',viewAccountSelector:'#fixture-account',viewConversationSelector:'#fixture-chat h2',viewPositionSelector:'#fixture-title',viewSelectionSelector:'#fixture-chat'});
    $('#fixture-blocked').hidden=true;$('#fixture-input').value='';
    adapter=new JobPageAdapter(document,profile);
    const assert=(ok,label)=>{if(!ok)throw Error(label);results.push('✓ '+label);};
    const rejects=(fn,label)=>{let rejected=false;try{fn();}catch{rejected=true;}assert(rejected,label);};
    assert(adapter.chat().needs_bind,'读取预览不会隐式建立页面绑定');
    const snap=adapter.bindChat();assert(snap.capture_mode==='snapshot'&&snap.binding.account.startsWith('view:'),'绑定生成页面句柄，不冒充平台账号ID');
    const action={id:'snapshot-test-1',binding:snap.binding,text:'【仅本机测试草稿，请勿发送】'};
    const expected={binding:snap.binding,messages:snap.messages};
    rejects(()=>adapter.fill(action,expected),'未在扩展确认时拒绝填入');
    adapter.fill(action,expected,true);assert($('#fixture-input').value===action.text,'逐次确认后填入草稿');
    assert(adapter.chat().messages.length===snap.messages.length,'填入不会发送消息');
    $('#fixture-input').value='';add('recruiter','好的');add('recruiter','好的');
    assert(adapter.chat().messages.slice(-2).every(m=>m.text==='好的'),'同内容的两条消息均保留');
    rejects(()=>adapter.fill({...action,id:'snapshot-test-2'},expected,true),'新消息使旧消息快照不可填入');
    const current=adapter.chat();$('#fixture-input').value='人工草稿';
    rejects(()=>adapter.fill({...action,id:'snapshot-test-3'},{binding:current.binding,messages:current.messages},true),'不覆盖人工草稿');$('#fixture-input').value='';
    $('#fixture-chat h2').textContent='招聘方会话 B';$('#fixture-chat h2').textContent=original.heading;
    await Promise.resolve();
    assert(adapter.chat().needs_bind,'切换会话再切回也会使页面句柄失效');
    const rebound=adapter.bindChat();assert(rebound.binding.account!==snap.binding.account,'重新绑定不复用旧页面句柄');
    rejects(()=>adapter.fill({...action,id:'snapshot-test-4'},expected,true),'旧绑定的草稿不能填入新会话');
    adapter.clearView();assert(adapter.chat().needs_bind,'解除绑定后不能继续使用旧会话');
    $('#fixture-tests').textContent=results.join('\n')+'\n聊天快照自检全部通过。真实页面另行联调。';
  }catch(error){$('#fixture-tests').textContent=results.join('\n')+'\n✗ '+error.message;}
  finally{adapter?.dispose();$('#fixture-messages').innerHTML=original.messages;$('#fixture-input').value=original.input;$('#fixture-chat h2').textContent=original.heading;$('#fixture-blocked').hidden=original.blocked;$('#fixture-chat').className=original.classes;}
};
