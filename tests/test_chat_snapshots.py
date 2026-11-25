from test_boss_connector import client, pair, imported


def snapshot(client, pair, headers, job, messages=None, baseline=False, nonce='one'):
    binding={k:'view:'+nonce for k in ['account','job','conversation']}
    response=client.post('/api/connector/'+pair['connection_id']+'/observations',headers=headers,json={
        'job_id':job,'binding':binding,'capture_mode':'snapshot','baseline':baseline,'confirmed':baseline,
        'labels':{'account':'测试求职者','conversation':'测试招聘方','position':'Python实习生'},
        'messages':messages if messages is not None else [{'role':'recruiter','text':'好的'},{'role':'recruiter','text':'好的'}]})
    return response,binding


def approved(client, pair):
    draft=client.post('/api/boss/connections/'+pair['connection_id']+'/drafts',json={'text':'【本机连接测试草稿，请勿发送】'}).json()
    assert client.post('/api/boss/actions/'+draft['id']+'/approve').status_code==200
    return draft


def test_snapshot_replaces_visible_window_and_preserves_identical_messages(client):
    connection,headers=pair(client);job=imported(client,connection,headers)
    response,_=snapshot(client,connection,headers,job,baseline=True)
    assert response.status_code==200
    for _ in range(3):
        assert snapshot(client,connection,headers,job)[0].status_code==200
    summary=client.get('/api/boss').json()
    assert len(summary['messages'])==2
    assert all(m['snapshot'] and m['text']=='好的' for m in summary['messages'])
    assert summary['connections'][0]['capture_mode']=='snapshot'
    assert snapshot(client,connection,headers,job,messages=[{'role':'me','text':'这是最新可见的一句话。'}])[0].status_code==200
    summary=client.get('/api/boss').json()
    assert len(summary['messages'])==1 and summary['messages'][0]['role']=='me'


def test_snapshot_cannot_claim_without_manual_extension_confirmation(client):
    connection,headers=pair(client);job=imported(client,connection,headers)
    observation,binding=snapshot(client,connection,headers,job,baseline=True)
    approved(client,connection)
    claim={'job_id':job,'binding':binding,'fingerprint':observation.json()['fingerprint']}
    path='/api/connector/'+connection['connection_id']+'/claim'
    assert client.post(path,headers=headers,json=claim).status_code==409
    claim['manual_confirmed']=True
    result=client.post(path,headers=headers,json=claim)
    assert result.status_code==200 and result.json()['action']['capture_mode']=='snapshot'
    assert client.post(path,headers=headers,json=claim).json()['action'] is None


def test_page_rebind_invalidates_old_draft_and_replaces_snapshot(client):
    connection,headers=pair(client);job=imported(client,connection,headers)
    snapshot(client,connection,headers,job,baseline=True)
    draft=approved(client,connection)
    assert snapshot(client,connection,headers,job,nonce='refreshed')[0].status_code==409
    assert snapshot(client,connection,headers,job,nonce='refreshed',baseline=True)[0].status_code==200
    assert client.get('/api/boss').json()['actions'][0]['state']=='CANCELLED'
    assert client.post('/api/boss/actions/'+draft['id']+'/approve').status_code==409
    assert len(client.get('/api/boss').json()['messages'])==2


def test_original_contact_detail_changes_invalidate_approved_draft(client):
    connection,headers=pair(client);job=imported(client,connection,headers)
    snapshot(client,connection,headers,job,baseline=True,messages=[{'role':'recruiter','text':'本人手机：13812348888'}])
    approved(client,connection)
    snapshot(client,connection,headers,job,messages=[{'role':'recruiter','text':'本人手机：13812349999'}])
    summary=client.get('/api/boss').json()
    assert summary['actions'][0]['state']=='CANCELLED'
    assert '1381234' not in str(summary['messages'])


def test_snapshot_cannot_pretend_display_name_is_platform_identity(client):
    connection,headers=pair(client);job=imported(client,connection,headers)
    response=client.post('/api/connector/'+connection['connection_id']+'/observations',headers=headers,json={
        'job_id':job,'capture_mode':'snapshot','binding':{'account':'测试求职者','job':'岗位名称','conversation':'招聘方姓名'},
        'messages':[],'baseline':True,'confirmed':True})
    assert response.status_code==422


def test_deleting_job_removes_snapshot_contents(client):
    connection,headers=pair(client);job=imported(client,connection,headers)
    snapshot(client,connection,headers,job,baseline=True)
    assert client.delete('/api/jobs/'+job).status_code==200
    summary=client.get('/api/boss').json()
    assert summary['messages']==[] and summary['connections'][0]['session'] is None


def test_snapshot_rejects_wrong_internal_job(client):
    connection,headers=pair(client);job=imported(client,connection,headers)
    response=client.post('/api/connector/'+connection['connection_id']+'/observations',headers=headers,json={
        'job_id':job,'capture_mode':'snapshot','binding':{k:'view:one' for k in ['account','job','conversation']},
        'labels':{'position':'CAD工程师'},'messages':[],'baseline':True,'confirmed':True})
    assert response.status_code==409 and '岗位不一致' in response.json()['detail']


def test_chat_job_is_explicitly_incomplete_until_requirements_are_added(client):
    connection,headers=pair(client)
    path='/api/connector/'+connection['connection_id']+'/chat-job'
    body={'title':'AI应用工程师','company':'示例团队','position':'AI应用工程师\n10-12K','confirmed':False}
    assert client.post(path,headers=headers,json=body).status_code==422
    body['confirmed']=True
    response=client.post(path,headers=headers,json=body)
    assert response.status_code==200
    job=client.get('/api/overview').json()['jobs'][0]
    assert job['source']=='boss-chat' and job['requirements']==[] and job['requirements_need_review']
    assert job['status']=='communicating'
    assert client.post('/api/jobs/'+job['id']+'/assess').status_code==409
