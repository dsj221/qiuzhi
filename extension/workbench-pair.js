'use strict';
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  if(sender.id!==chrome.runtime.id||
     sender.url!==chrome.runtime.getURL('panel.html')||location.href!=='http://127.0.0.1:8766/')return false;
  if(message.type==='PAIR_READY'){reply({ready:!!document.querySelector('#boss-pair-form')});return false;}
  if(message.type!=='CREATE_LOCAL_PAIR')return false;
  (async()=>{
    const form=document.querySelector('#boss-pair-form'),output=document.querySelector('#boss-pair-value');
    if(!form||!output||output.value)throw Error('工作台配对表单尚未就绪');
    form.elements.label.value='自动求职 · 本机 Chrome';
    form.requestSubmit(form.querySelector('button[type=submit]'));
    for(let attempt=0;attempt<40;attempt++){
      if(output.value){const value=output.value;output.value='';return {value};}
      const error=document.querySelector('#boss-modal-error:not(.hidden)');
      if(error?.textContent)throw Error(error.textContent);
      await new Promise(resolve=>setTimeout(resolve,250));
    }
    throw Error('首次配对超时，请检查本机服务');
  })().then(reply).catch(error=>reply({error:error.message}));
  return true;
});
