import base64
import importlib

import pytest
from fastapi.testclient import TestClient

from job_agent.model import Model


RESUME = '本人手机：13812348888\n邮箱：private@example.test\n项目经历：使用 Python 和 FastAPI 开发报名服务，负责接口设计和测试，使用 SQLite 保存报名记录。'
JOB = {"title": "Python 开发实习生", "company": "示例公司", "requirements": [
    {"id": "R1", "text": "Python 开发", "keywords": ["Python"], "weight": 5},
    {"id": "R2", "text": "Docker 部署", "keywords": ["Docker"], "weight": 3}]}


@pytest.fixture
def client(tmp_path, monkeypatch):
    for name in ['MODEL_BASE_URL', 'MODEL_NAME', 'MODEL_API_KEY']:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv('JOB_AGENT_DATA', str(tmp_path / 'default'))
    module = importlib.import_module('job_agent.app')
    app = module.create_app(tmp_path / 'test', testing=True)
    with TestClient(app) as client:
        client.headers['Authorization'] = 'Bearer ' + app.state.service.admin_token
        yield client
    app.state.service.store.db.close()


def profile(client, text=RESUME):
    response = client.put('/api/profile', json={'name': '测试求职者', 'target': '后端实习', 'text': text})
    assert response.status_code == 200
    return response.json()


def job(client):
    response = client.post('/api/jobs', json=JOB)
    assert response.status_code == 200
    return response.json()


def test_profile_reused_across_jobs_with_exact_evidence(client):
    saved = profile(client)
    assert '13812348888' not in saved['text']
    assert 'private@example.test' not in saved['text']
    one, two = job(client), job(client)
    for record in [one, two]:
        report = client.post(f'/api/jobs/{record["id"]}/assess').json()
        assert report['engine'] == 'rules'
        assert report['coverage'] == .62
        assert report['rows'][1]['status'] == 'unknown'
        assert report['rows'][1]['score'] is None
        for row in report['rows']:
            for evidence in row['evidence']:
                assert evidence['quote'] in saved['text']
    assert len(client.get('/api/overview').json()['jobs']) == 2


def test_resume_changes_invalidate_reports_and_preparation(client):
    profile(client)
    record = job(client)
    client.post(f'/api/jobs/{record["id"]}/assess')
    assert client.get(f'/api/jobs/{record["id"]}/preparation').status_code == 200
    updated = profile(client, '项目经历：使用 Vue 开发活动报名页面，负责页面交互、表单校验和组件文档维护。')
    assert updated['revision'] == 2
    assert client.get('/api/overview').json()['jobs'][0]['report'] is None
    assert client.get(f'/api/jobs/{record["id"]}/preparation').status_code == 409


def test_application_status_history_and_date_validation(client):
    record = job(client)
    for status in ['applied', 'interview', 'offer']:
        response = client.put(f'/api/jobs/{record["id"]}/tracking', json={'status': status, 'followup_date': '2026-12-01', 'notes': '准备真实项目案例'})
        assert response.status_code == 200
    assert [h['status'] for h in response.json()['history']] == ['saved', 'applied', 'interview', 'offer']
    assert client.put(f'/api/jobs/{record["id"]}/tracking', json={'status': 'sent'}).status_code == 422
    assert client.put(f'/api/jobs/{record["id"]}/tracking', json={'status': 'applied', 'followup_date': '2026-02-31'}).status_code == 422


def test_preparation_uses_real_evidence_and_flags_missing_experience(client):
    saved = profile(client)
    record = job(client)
    client.post(f'/api/jobs/{record["id"]}/assess')
    prep = client.get(f'/api/jobs/{record["id"]}/preparation').json()
    assert prep['engine'] == 'template'
    assert len(prep['questions']) == 2
    assert prep['questions'][1]['evidence'] == []
    assert '如实说明' in prep['questions'][1]['tip']
    assert 'Docker' not in prep['greeting']
    assert prep['questions'][0]['evidence'][0]['quote'] in saved['text']


def test_no_match_without_profile_and_empty_evidence_has_no_score(client):
    record = job(client)
    assert client.post(f'/api/jobs/{record["id"]}/assess').status_code == 409
    profile(client, '项目经历：维护社团活动页面，整理文档，负责成员报名和日程安排，参与团队协作。')
    report = client.post(f'/api/jobs/{record["id"]}/assess').json()
    assert report['score'] is None and report['coverage'] == 0


def test_delete_profile_clears_all_reports_but_keeps_tracking(client):
    profile(client)
    record = job(client)
    client.post(f'/api/jobs/{record["id"]}/assess')
    client.put(f'/api/jobs/{record["id"]}/tracking', json={'status': 'applied'})
    assert client.delete('/api/profile').status_code == 200
    overview = client.get('/api/overview').json()
    assert overview['profile'] is None
    assert overview['jobs'][0]['report'] is None
    assert overview['jobs'][0]['status'] == 'applied'
    assert client.delete(f'/api/jobs/{record["id"]}').status_code == 200
    assert client.get('/api/overview').json()['jobs'] == []


def test_auth_origin_host_and_static_isolation(client):
    assert client.get('/api/overview', headers={'Authorization': ''}).status_code == 401
    assert client.get('/api/overview', headers={'Origin': 'https://evil.test'}).status_code == 403
    assert client.get('/api/overview', headers={'Origin': 'http://localhost:8765'}).status_code == 403
    assert client.get('/api/overview', headers={'Host': 'evil.test'}).status_code == 403
    page = client.get('/')
    assert page.status_code == 200 and '求职 Agent' in page.text
    assert 'script-src' in page.headers['content-security-policy']
    assert client.get('/static/app.js').status_code == 200
    assert client.get('/static/admin.token').status_code == 404
    assert client.get('/api/connector/connections').status_code == 404


def test_document_extraction_and_invalid_documents(client):
    content = base64.b64encode(RESUME.encode()).decode()
    result = client.post('/api/files/extract', json={'name':'resume.txt','content':content})
    assert result.status_code == 200 and result.json()['text'] == RESUME
    assert client.post('/api/files/extract', json={'name':'resume.pdf','content':content}).status_code == 422
    assert client.post('/api/files/extract', json={'name':'resume.exe','content':content}).status_code == 422
    assert client.post('/api/files/extract', json={'name':'resume.txt','content':'@@@'}).status_code == 422


def test_duplicate_requirement_empty_keyword_and_unsafe_links(client):
    data = {**JOB, 'requirements': [JOB['requirements'][0], JOB['requirements'][0]]}
    assert client.post('/api/jobs', json=data).status_code == 422
    data = {**JOB, 'requirements': [{**JOB['requirements'][0], 'keywords': [' ']}]}
    assert client.post('/api/jobs', json=data).status_code == 422
    for url in ['javascript:alert(1)', 'https://', 'file:///etc/passwd']:
        assert client.post('/api/jobs', json={**JOB,'url':url}).status_code == 422


def test_demo_only_loads_into_empty_workspace(client):
    assert client.post('/api/demo').status_code == 200
    assert client.post('/api/demo').status_code == 409
    assert '虚构公司' in client.get('/api/overview').json()['jobs'][0]['company']


def test_invalid_model_evidence_is_not_accepted():
    model=Model()
    model.base, model.name, model.key='https://example.test', 'test', 'test'
    model.call=lambda *args: {'rows':[{'requirement_id':'R1','status':'met','level':'strong','evidence':[{'source_id':'resume','quote':'不存在的 Python 经历'}]}]}
    result=model.assess([JOB['requirements'][0]],[{'id':'resume','text':'维护活动页面'}])
    assert result['rows'][0]['status']=='unknown'
    assert result['score'] is None


def test_database_survives_restart(client):
    profile(client)
    record=job(client)
    from job_agent.service import Service
    db_path=client.app.state.service.store.db.execute('PRAGMA database_list').fetchone()[2]
    from pathlib import Path
    another=Service(Path(db_path).parent)
    assert another.overview()['jobs'][0]['id']==record['id']
    assert another.admin_token==client.app.state.service.admin_token
    another.store.db.close()
