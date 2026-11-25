import pytest

from test_boss_connector import client, pair
from test_opportunities import prepare, approve, setup, collect, job


def jd(**overrides):
    return {'external_id': 'jd-role-1', 'title': 'Python工程师', 'company': '虚构研发团队', 'city': '上海',
            'description': '岗位职责：使用 Python 开发业务服务，维护业务接口。\n岗位要求：了解 SQL 与自动化测试，能说明项目中的职责。',
            'url': 'https://www.zhipin.com/job_detail/jd-role-1.html', 'confirmed': True, **overrides}


def chat_job(client, connection, headers):
    response = client.post('/api/connector/' + connection['connection_id'] + '/chat-job', headers=headers,
                           json={'title': 'Python工程师', 'company': '虚构研发团队', 'position': 'Python工程师\n10-15K', 'confirmed': True})
    assert response.status_code == 200
    return response.json()['job_id']


def update(client, connection, headers, job_id, **overrides):
    return client.post('/api/connector/' + connection['connection_id'] + '/jobs/' + job_id + '/jd', headers=headers, json=jd(**overrides))


def test_chat_jd_is_completed_in_place_and_keeps_tracking(client):
    connection, headers = pair(client)
    job_id = chat_job(client, connection, headers)
    client.put('/api/jobs/' + job_id + '/tracking', json={'status': 'interview', 'notes': '周五准备面试', 'followup_date': '2026-12-01'})
    path = '/api/connector/' + connection['connection_id'] + '/jobs'
    assert client.get(path, headers=headers).json()['jobs'][0]['needs_jd']
    assert update(client, connection, headers, job_id).json()['changed']
    jobs = client.get('/api/overview').json()['jobs']
    assert len(jobs) == 1
    job = jobs[0]
    assert job['id'] == job_id and job['description'] == jd()['description']
    assert job['boss_external_id'] == 'jd-role-1' and job['requirements_need_review'] and job['requirements']
    assert job['status'] == 'interview' and job['notes'] == '周五准备面试' and job['followup_date'] == '2026-12-01'
    assert job['jd_fetched_at'] and job['jd_source_url'] == jd()['url']
    assert not client.get(path, headers=headers).json()['jobs'][0]['needs_jd']
    assert client.post('/api/jobs/' + job_id + '/assess').status_code == 409


def test_unchanged_jd_preserves_reviewed_requirements_and_report(client):
    connection, headers = pair(client)
    job_id = chat_job(client, connection, headers)
    update(client, connection, headers, job_id)
    client.put('/api/profile', json={'name': '测试求职者', 'text': '项目经历：使用 Python 和 SQL 开发业务接口，并维护自动化测试与服务。'})
    requirements = [{'id': 'R1', 'text': 'Python开发', 'keywords': ['Python'], 'weight': 5}]
    assert client.put('/api/jobs/' + job_id + '/requirements', json={'requirements': requirements}).status_code == 200
    assert client.post('/api/jobs/' + job_id + '/assess').status_code == 200
    old = client.get('/api/overview').json()['jobs'][0]
    assert update(client, connection, headers, job_id).json()['changed'] is False
    current = client.get('/api/overview').json()['jobs'][0]
    assert current['requirements'] == requirements and current['report'] == old['report']
    assert current['requirements_need_review'] is False
    assert update(client, connection, headers, job_id, description=jd()['description'] + '\n额外要求：了解 Docker 部署。').status_code == 200
    current = client.get('/api/overview').json()['jobs'][0]
    assert current['report'] is None and current['requirements_need_review']


@pytest.mark.parametrize('override', [
    {'title': 'Java工程师'}, {'company': '另一家公司'},
    {'url': 'https://www.zhipin.com/job_detail/other.html'},
    {'url': 'https://evil.example/job_detail/jd-role-1.html'},
    {'url': 'https://www.zhipin.com:abc/job_detail/jd-role-1.html'},
    {'url': 'https://user@www.zhipin.com/job_detail/jd-role-1.html'},
    {'description': ' ' * 25}, {'confirmed': False},
])
def test_wrong_or_incomplete_jd_does_not_overwrite_job(client, override):
    connection, headers = pair(client)
    job_id = chat_job(client, connection, headers)
    before = client.get('/api/overview').json()['jobs'][0]
    assert update(client, connection, headers, job_id, **override).status_code in {409, 422}
    assert client.get('/api/overview').json()['jobs'][0] == before


def test_known_external_id_cannot_be_rebound_and_revoked_token_cannot_write(client):
    connection, headers = pair(client)
    job_id = chat_job(client, connection, headers)
    assert update(client, connection, headers, job_id).status_code == 200
    assert update(client, connection, headers, job_id, external_id='other', url='https://www.zhipin.com/job_detail/other.html').status_code == 409
    client.delete('/api/boss/connections/' + connection['connection_id'])
    assert update(client, connection, headers, job_id).status_code == 401


def test_changed_jd_invalidates_screening_and_pending_batch(client):
    connection, headers = setup(client)
    source, prepared = prepare(client, connection, headers)
    assert approve(client, prepared).status_code == 200
    job_id = prepared['items'][0]['job_id']
    assert update(client, connection, headers, job_id, external_id=source['external_id'], url=source['url']).status_code == 200
    assert client.get('/api/opportunities').json()['opportunities'][0]['stale']
    assert client.get('/api/applications').json()['batches'][0]['state'] == 'NEEDS_REVIEW'
    assert client.post('/api/applications', json={'connection_id': connection['connection_id'], 'account_label': '测试账号',
        'opportunity_ids': prepared['batch']['opportunity_ids'], 'mode': 'greeting'}).status_code == 409


def test_changed_jd_invalidates_unfavorited_opportunity_by_posting_id(client):
    connection, headers = setup(client, auto_favorite=False)
    source = job()
    value = collect(client, connection, headers, [source]).json()['opportunities'][0]
    assert not value.get('favorite_id')
    imported = client.post('/api/connector/' + connection['connection_id'] + '/jobs', headers=headers,
                           json={**source, 'confirmed': True}).json()['job_id']
    assert update(client, connection, headers, imported, external_id=source['external_id'], url=source['url']).status_code == 200
    assert client.get('/api/opportunities').json()['opportunities'][0]['stale']
    assert client.post('/api/applications', json={'connection_id': connection['connection_id'], 'account_label': '测试账号',
        'opportunity_ids': [value['id']], 'mode': 'greeting'}).status_code == 409


def test_jd_change_during_assessment_cannot_restore_old_report(client, monkeypatch):
    connection, headers = pair(client)
    job_id = chat_job(client, connection, headers)
    update(client, connection, headers, job_id)
    client.put('/api/profile', json={'name': '测试求职者', 'text': '项目经历：使用 Python 和 SQL 开发业务接口，并维护自动化测试与服务。'})
    client.put('/api/jobs/' + job_id + '/requirements', json={'requirements': [{'id': 'R1', 'text': 'Python开发', 'keywords': ['Python'], 'weight': 3}]})
    assess = client.app.state.service.model.assess
    def updating_assess(*args):
        client.app.state.connector.update_jd(connection['connection_id'], connection['token'], job_id,
                                            jd(description=jd()['description'] + '\n新增要求：负责部署。'))
        return assess(*args)
    monkeypatch.setattr(client.app.state.service.model, 'assess', updating_assess)
    assert client.post('/api/jobs/' + job_id + '/assess').status_code == 409
    assert client.get('/api/overview').json()['jobs'][0]['report'] is None
