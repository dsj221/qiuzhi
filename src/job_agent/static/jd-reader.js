/* Read public job fields only; downloaded HTML is parsed inertly, never rendered. */
(function(root){
  'use strict';
  function officialURL(value){
    const url=new URL(value);
    if(url.origin!=='https://www.zhipin.com'||url.username||url.password||!/^\/job_detail\/[\w-]+\.html$/.test(url.pathname))throw Error('请使用 BOSS 官方岗位详情链接');
    return url.origin+url.pathname;
  }
  function read(doc,value){
    const url=officialURL(value),external_id=new URL(url).pathname.match(/\/([\w-]+)\.html$/)[1];
    const text=el=>{
      if(doc.defaultView&&typeof el.innerText==='string')return el.innerText.trim();
      const copy=el.cloneNode(true);copy.querySelectorAll('script,style,iframe,noscript').forEach(el=>el.remove());
      copy.querySelectorAll('br').forEach(el=>el.replaceWith('\n'));
      copy.querySelectorAll('p,li,div').forEach(el=>el.append('\n'));
      return (copy.textContent||'').trim();
    };
    function field(selectors,required=true){
      for(const selector of selectors){
        const nodes=[...doc.querySelectorAll(selector)].filter(el=>{
          if(!text(el))return false;
          for(let p=el;p;p=p.parentElement){
            if(p.hidden||p.getAttribute('aria-hidden')==='true')return false;
            const style=doc.defaultView?.getComputedStyle(p);
            if(style?.display==='none'||style?.visibility==='hidden')return false;
          }
          return true;
        });
        if(nodes.length>1)throw Error('详情页存在多份岗位信息，请在浏览器打开目标岗位后重试');
        if(nodes.length===1)return text(nodes[0]);
      }
      if(required)throw Error('未读取到完整 JD，页面可能需要登录或由浏览器加载；请打开岗位详情后重试');
      return '';
    }
    const title=field(['.job-banner .name h1','.job-banner h1']);
    let company=field(['.sider-company .company-info .company-name','.company-info .name a','.company-info .name'],false);
    if(!company){
      const banner=doc.querySelector('.job-banner');
      if(banner){
        const walker=doc.createTreeWalker(banner,4);let node;
        while((node=walker.nextNode())){
          const match=(node.textContent||'').trim().match(/^客户公司[：:]\s*(.*)$/);
          if(!match)continue;
          company=match[1].trim();
          while(!company&&(node=walker.nextNode()))company=(node.textContent||'').trim();
          break;
        }
      }
    }
    if(!company){
      const name=field(['.job-sider .sider-company .company-info'],false);
      if(name&&!/[\r\n]/.test(name))company=name;
    }
    if(!company)throw Error('未读取到岗位公司或猎头客户公司，请打开完整岗位详情后重试');
    const description=field(['.job-detail-section > .job-sec-text:not(.fold-text)', '.job-detail-section .job-sec-text:not(.fold-text)', '.job-sec-text']);
    const city=field(['.job-banner .text-city','.job-banner .job-area'],false);
    if(title.length<2||title.length>80||company.length>100||description.length<20||description.length>20000||city.length>80)throw Error('岗位正文字段不完整或过长，请打开完整详情后重试');
    return {external_id,title,company,description,city,url};
  }
  root.JobJD={officialURL,read};
  if(typeof module!=='undefined')module.exports=root.JobJD;
})(typeof globalThis!=='undefined'?globalThis:window);
