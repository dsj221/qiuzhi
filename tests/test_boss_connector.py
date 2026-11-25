import importlib

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv('JOB_AGENT_DATA',str(tmp_path/'default'))
    module=importlib.import_module('job_agent.app')
    app=module.create_app(tmp_path/'test',testing=True)
    with TestClient(app) as client:
        client.headers['Authorization']='Bearer '+app.state.service.admin_token
        yield client
    app.state.service.store.db.close()


def pair(client):
    value=client.post('/api/boss/connections',json={'label':'测试Chrome'}).json()
    return value, {'Authorization':'Bearer '+value['token'],'Origin':'chrome-extension://'+'a'*32}


def imported(client,pair,headers):
    response=client.post('/api/connector/'+pair['connection_id']+'/jobs',headers=headers,json={
        'external_id':'boss-job-1','title':'Python实习生','company':'虚构公司','description':'使用 Python 开发业务接口，维护 SQL 数据库，并编写测试。',
        'url':'https://www.zhipin.com/job_detail/test123.html','confirmed':True})
    assert response.status_code==200
    return response.json()['job_id']


def observe(client,pair,headers,job,messages=None,baseline=False,binding=None):
    return client.post('/api/connector/'+pair['connection_id']+'/observations',headers=headers,json={
        'job_id':job,'binding':binding or {'account':'my-account','job':'boss-job-1','conversation':'boss-recruiter-A'},
        'messages':messages or [{'event_key':'message-1','role':'recruiter','text':'你好，可以介绍一下你的项目吗？'}],
        'baseline':baseline,'confirmed':baseline})


def test_pairing_token_is_scoped_and_revocable(client):
    value,headers=pair(client)
    path='/api/connector/'+value['connection_id']+'/jobs'
    assert client.get(path,headers=headers).status_code==200
    assert client.get('/api/overview',headers=headers).status_code==403
    assert client.get(path,headers={'Authorization':'Bearer wrong'}).status_code==401
    assert 'token_hash' not in str(client.get('/api/boss').json())
    client.delete('/api/boss/connections/'+value['connection_id'])
    assert client.get(path,headers=headers).status_code==401


def test_extension_cors_preflight_is_limited_to_connector(client):
    origin='chrome-extension://'+'a'*32
    response=client.options('/api/connector/test/jobs',headers={'Origin':origin,'Access-Control-Request-Headers':'Authorization'})
    assert response.status_code==204 and response.headers['access-control-allow-origin']==origin
    assert client.options('/api/boss',headers={'Origin':origin}).status_code==403


def test_import_is_deduplicated_and_requirements_need_review(client):
    value,headers=pair(client)
    one=imported(client,value,headers)
    assert imported(client,value,headers)==one
    client.put('/api/profile',json={'name':'测试','text':'项目经历：使用 Python 和 SQL 开发活动报名接口，维护服务与测试。'})
    assert client.post('/api/jobs/'+one+'/assess').status_code==409
    requirements=[{'id':'R1','text':'Python开发','keywords':['Python'],'weight':3}]
    assert client.put('/api/jobs/'+one+'/requirements',json={'requirements':requirements}).status_code==200
    assert client.post('/api/jobs/'+one+'/assess').status_code==200
    assert client.put('/api/jobs/'+one+'/requirements',json={'requirements':requirements}).status_code==409


def test_observations_require_baseline_and_do_not_trigger_replies(client):
    value,headers=pair(client);job=imported(client,value,headers)
    assert observe(client,value,headers,job).status_code==409
    assert observe(client,value,headers,job,baseline=True).status_code==200
    assert observe(client,value,headers,job).status_code==200
    summary=client.get('/api/boss').json()
    assert len(summary['messages'])==1 and not summary['actions']
    assert observe(client,value,headers,job,binding={'account':'other','job':'boss-job-1','conversation':'boss-recruiter-A'}).status_code==409


def test_approved_draft_fills_once_with_scoped_lease(client):
    value,headers=pair(client);job=imported(client,value,headers)
    observed=observe(client,value,headers,job,baseline=True).json()
    draft=client.post('/api/boss/connections/'+value['connection_id']+'/drafts',json={'text':'您好，这是我确认后的沟通草稿。'}).json()
    claim_data={'job_id':job,'binding':{'account':'my-account','job':'boss-job-1','conversation':'boss-recruiter-A'},'fingerprint':observed['fingerprint']}
    claim_path='/api/connector/'+value['connection_id']+'/claim'
    assert client.post(claim_path,headers=headers,json=claim_data).json()['action'] is None
    assert client.post('/api/boss/actions/'+draft['id']+'/approve').status_code==200
    action=client.post(claim_path,headers=headers,json=claim_data).json()['action']
    assert action['text']==draft['text'] and action['lease']
    assert client.post(claim_path,headers=headers,json=claim_data).json()['action'] is None
    result_path='/api/connector/'+value['connection_id']+'/actions/'+action['id']+'/result'
    assert client.post(result_path,headers=headers,json={'lease':'incorrect-token','outcome':'FILLED'}).status_code==403
    assert client.post(result_path,headers=headers,json={'lease':action['lease'],'outcome':'FILLED'}).status_code==200
    assert client.get('/api/boss').json()['actions'][0]['state']=='FILLED'
    assert client.get('/api/overview').json()['jobs'][0]['status']=='saved'
    assert client.post('/api/boss/actions/'+action['id']+'/resolve').status_code==200
    assert client.get('/api/boss').json()['actions'][0]['state']=='CHECKED'


def test_new_message_invalidates_approved_draft(client):
    value,headers=pair(client);job=imported(client,value,headers)
    observe(client,value,headers,job,baseline=True)
    draft=client.post('/api/boss/connections/'+value['connection_id']+'/drafts',json={'text':'这是待确认的测试草稿。'}).json()
    client.post('/api/boss/actions/'+draft['id']+'/approve')
    assert observe(client,value,headers,job,messages=[{'event_key':'message-2','role':'recruiter','text':'新增的问题，请先回答这个问题。'}]).status_code==200
    assert client.get('/api/boss').json()['actions'][0]['state']=='CANCELLED'


def test_unknown_fill_blocks_new_drafts_until_checked(client):
    value,headers=pair(client);job=imported(client,value,headers)
    observed=observe(client,value,headers,job,baseline=True).json()
    draft=client.post('/api/boss/connections/'+value['connection_id']+'/drafts',json={'text':'这是待确认的测试草稿。'}).json()
    client.post('/api/boss/actions/'+draft['id']+'/approve')
    action=client.post('/api/connector/'+value['connection_id']+'/claim',headers=headers,json={'job_id':job,'binding':{'account':'my-account','job':'boss-job-1','conversation':'boss-recruiter-A'},'fingerprint':observed['fingerprint']}).json()['action']
    assert action
    assert client.post('/api/boss/connections/'+value['connection_id']+'/drafts',json={'text':'不要重复填入这条草稿。'}).status_code==409
    client.post('/api/boss/actions/'+draft['id']+'/resolve')
    assert client.post('/api/boss/connections/'+value['connection_id']+'/drafts',json={'text':'已检查输入框，创建新的草稿。'}).status_code==200


def test_delete_job_removes_synced_messages_and_binding(client):
    value,headers=pair(client);job=imported(client,value,headers)
    observe(client,value,headers,job,baseline=True)
    client.delete('/api/jobs/'+job)
    summary=client.get('/api/boss').json()
    assert not summary['messages'] and summary['connections'][0]['session'] is None
