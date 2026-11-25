'use strict';
let jdBusy=false;
async function fetchJobJD(jobId,automatic=false){
  if(jdBusy){if(!automatic)$('#jd-status').textContent='正在获取JD，请稍候。';return;}
  if(!jobId){if(!automatic)$('#jd-status').textContent='请先选择要补全JD的内部岗位。';return;}
  jdBusy=true;$('#fetch-job-jd').disabled=true;
  try{
    const target=(await api('JOBS')).jobs.find(job=>job.id===jobId);
    if(!target)throw Error('所选岗位已不存在，请刷新岗位列表');
    if(automatic&&!target.needs_jd)return;
    $('#jd-status').textContent='正在获取 '+target.title+' 的完整 JD…';
    const same=(a,b)=>a.replace(/\s/g,'').toLocaleLowerCase()===b.replace(/\s/g,'').toLocaleLowerCase();
    const matches=job=>same(job.title,target.title)&&same(job.company,target.company)&&(!target.external_id||job.external_id===target.external_id);
    let details=null;
    for(const type of ['READ_JOB','READ_DETAIL_JOB']){
      try{const {tabId,...current}=await page(type);if(matches(current)){details=current;break;}}catch{}
    }
    if(!details){
      const link=target.url?{url:target.url}:await page('READ_JOB_LINK');
      const url=JobJD.officialURL(link.url);
      const fetched=await api('FETCH_JOB_HTML',{url});
      details=JobJD.read(new DOMParser().parseFromString(fetched.html,'text/html'),fetched.url);
    }
    if(!matches(details))throw Error('获取的JD与所选岗位或公司不一致，未覆盖原档案');
    if($('#job').value!==jobId)throw Error('所选岗位已变化，请重新获取JD');
    const result=await api('UPDATE_JOB_JD',{...details,confirmed:true},jobId);
    await jobs(jobId);
    $('#jd-status').textContent=result.changed?'完整 JD 已保存，请回工作台校对岗位要求后重新匹配。':'JD 已是最新内容，已保留现有要求和匹配结果。';
  }catch(error){$('#jd-status').textContent='JD 获取未完成：'+error.message+'。可打开对应岗位完整详情后点击重试。';}
  finally{jdBusy=false;$('#fetch-job-jd').disabled=false;}
}
function autoFetchJobJD(jobId){if($('#auto-fetch-jd').checked)void fetchJobJD(jobId,true);}
$('#fetch-job-jd').onclick=()=>void fetchJobJD($('#job').value);
(async()=>{
  const saved=await chrome.storage.local.get('autoFetchJD');
  if(typeof saved.autoFetchJD==='boolean')$('#auto-fetch-jd').checked=saved.autoFetchJD;
})().catch(error=>{$('#jd-status').textContent=error.message;});
$('#auto-fetch-jd').onchange=()=>{void chrome.storage.local.set({autoFetchJD:$('#auto-fetch-jd').checked}).catch(error=>{$('#jd-status').textContent=error.message;});};
