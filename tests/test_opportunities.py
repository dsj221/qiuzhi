import time
from urllib.parse import parse_qs, urlsplit

import pytest

from test_boss_connector import client, pair


def setup(client, **preferences):
    connection, headers = pair(client)
    assert client.put('/api/profile', json={'name': '本人测试档案', 'text': '项目经历：使用 Python 开发业务服务和自动化工具，负责需求实现、调试及测试。'}).status_code == 200
    prefs = {'titles': ['Python'], 'cities': ['上海'], 'min_salary_k': 10, 'min_score': 50, 'min_coverage': .5, **preferences}
    assert client.put('/api/opportunities/preferences', json=prefs).status_code == 200
    return connection, headers


def job(key='role-1', **overrides):
    return {'external_id': key, 'title': 'Python工程师', 'company': '虚构研发团队', 'city': '上海·杨浦区',
            'url': 'https://www.zhipin.com/job_detail/' + key + '.html',
            'description': '岗位职责：使用 Python 开发业务服务，参与需求评审、接口调试和服务维护工作。',
            'salary_text': '12-18K', 'salary_min_k': 12, 'salary_max_k': 18, **overrides}


def collect(client, connection, headers, jobs):
    return client.post('/api/connector/' + connection['connection_id'] + '/opportunities', headers=headers, json={'jobs': jobs})


def prepare(client, connection, headers, mode='resume'):
    source = job()
    value = collect(client, connection, headers, [source]).json()['opportunities'][0]
    response = client.post('/api/applications', json={'connection_id': connection['connection_id'], 'account_label': '测试账号',
        'opportunity_ids': [value['id']], 'mode': mode, 'resume_label': '本人简历.pdf'})
    assert response.status_code == 200, response.text
    return source, response.json()


def approve(client, prepared):
    batch = prepared['batch']
    return client.post('/api/applications/' + batch['id'] + '/approve', json={'digest': batch['digest'], 'targets_confirmed': True, 'resume_confirmed': True})


def claim(client, connection, headers, source, prepared):
    return client.post('/api/connector/' + connection['connection_id'] + '/applications/claim', headers=headers,
                       json={'batch_id': prepared['batch']['id'], 'account_label': '测试账号', 'job': source})


def preflight(client, connection, headers, action, stage='send_resume', **overrides):
    return client.post('/api/connector/' + connection['connection_id'] + '/applications/' + action['id'] + '/preflight', headers=headers,
                       json={'lease': action['lease'], 'stage': stage, 'target_verified': True, 'account_label': '测试账号',
                             'resume_label': '本人简历.pdf', 'message_ids': ['old-receipt'], **overrides})


def result(client, connection, headers, action, **overrides):
    return client.post('/api/connector/' + connection['connection_id'] + '/applications/' + action['id'] + '/result', headers=headers,
                       json={'lease': action['lease'], 'outcome': 'RESUME_SENT', 'receipt_key': 'new-receipt',
                             'evidence': '本人简历.pdf 已发送给BOSS', **overrides})


def test_screening_filters_unknown_salary_and_favorites_deduplicate(client):
    connection, headers = setup(client)
    values = collect(client, connection, headers, [job(), job('low', salary_min_k=8), job('city', city='杭州'),
        job('intern', title='Python实习生'), job('unknown', salary_min_k=None, salary_max_k=None, salary_text='面议'),
        job('missing', description='暂无正文'), job('role', title='Java工程师')]).json()['opportunities']
    assert [v['screening']['result'] for v in values] == ['matched', 'excluded', 'excluded', 'excluded', 'review', 'review', 'excluded']
    assert len(client.get('/api/overview').json()['jobs']) == 1
    again = collect(client, connection, headers, [job()]).json()['opportunities'][0]
    assert again['favorite_id'] == values[0]['favorite_id']
    assert len(client.get('/api/overview').json()['jobs']) == 1
    assert len(client.get('/api/opportunities').json()['opportunities']) == len(values)


def test_accept_internship_other_city_and_manual_favorite(client):
    connection, headers = setup(client, accept_internship=True, accept_other_cities=True, auto_favorite=False)
    value = collect(client, connection, headers, [job(title='Python实习生', city='杭州')]).json()['opportunities'][0]
    assert value['screening']['result'] == 'matched' and not value.get('favorite_id')
    assert client.post('/api/opportunities/' + value['id'] + '/favorite').status_code == 200
    assert client.post('/api/opportunities/' + value['id'] + '/favorite').status_code == 200
    assert len(client.get('/api/overview').json()['jobs']) == 1


def test_required_keywords_and_excluded_company(client):
    connection, headers = setup(client, required_keywords=['RAG'], excluded_companies=['研发团队'])
    value = collect(client, connection, headers, [job()]).json()['opportunities'][0]
    assert value['screening']['result'] == 'excluded'
    assert len(value['screening']['excluded_reasons']) == 2


def test_source_id_cannot_claim_different_official_job(client):
    connection, headers = setup(client)
    assert collect(client, connection, headers, [job(url='https://www.zhipin.com/job_detail/other.html')]).status_code == 422
    assert collect(client, connection, headers, [job(url='https://evil.example/job_detail/role-1.html')]).status_code == 422
    assert client.get('/api/opportunities', headers=headers).status_code == 403


def test_batch_needs_concrete_approval_and_never_double_claims(client):
    connection, headers = setup(client)
    source, prepared = prepare(client, connection, headers)
    assert claim(client, connection, headers, source, prepared).status_code == 409
    b = prepared['batch']
    assert client.post('/api/applications/' + b['id'] + '/approve', json={'digest': b['digest'], 'targets_confirmed': False, 'resume_confirmed': True}).status_code == 422
    assert client.post('/api/applications/' + b['id'] + '/approve', json={'digest': 'wrong', 'targets_confirmed': True, 'resume_confirmed': True}).status_code == 409
    assert approve(client, prepared).status_code == 200
    assert approve(client, prepared).status_code == 409
    assert claim(client, connection, headers, source, prepared).status_code == 200
    assert claim(client, connection, headers, source, prepared).status_code == 409
    duplicate = client.post('/api/applications', json={'connection_id': connection['connection_id'], 'account_label': '测试账号', 'mode': 'greeting', 'opportunity_ids': b['opportunity_ids']})
    assert duplicate.status_code == 409


@pytest.mark.parametrize('change', ['profile', 'preferences', 'description', 'account', 'revoke'])
def test_changed_screening_or_target_blocks_execution(client, change):
    connection, headers = setup(client)
    source, prepared = prepare(client, connection, headers)
    assert approve(client, prepared).status_code == 200
    if change == 'profile':
        client.put('/api/profile', json={'name': '新版本', 'text': '新项目：使用 Python 开发业务接口，维护数据库并负责编写自动化测试。'})
    elif change == 'preferences':
        client.put('/api/opportunities/preferences', json={'titles': ['Python'], 'cities': ['杭州']})
    elif change == 'description':
        source['description'] += ' 还需负责部署。'
    elif change == 'account':
        prepared['batch']['id'] = 'not-a-batch'
    else:
        client.delete('/api/boss/connections/' + connection['connection_id'])
    assert claim(client, connection, headers, source, prepared).status_code >= 400
    if change in {'profile', 'preferences'}:
        assert client.get('/api/opportunities').json()['opportunities'][0]['stale']


@pytest.mark.parametrize('outcome,evidence,status', [
    ('RESUME_SENT', '本人简历.pdf 已发送给BOSS', 'applied'),
    ('RESUME_REQUESTED', '已请求发送简历，请等待对方同意', 'communicating'),
    ('COMMUNICATING', None, 'communicating'),
    ('UNKNOWN', '', 'saved'),
])
def test_platform_receipts_distinguish_delivery_from_communication(client, outcome, evidence, status):
    connection, headers = setup(client)
    source, prepared = prepare(client, connection, headers, mode='greeting' if outcome == 'COMMUNICATING' else 'resume')
    approve(client, prepared)
    action = claim(client, connection, headers, source, prepared).json()['action']
    assert result(client, connection, headers, action, outcome=outcome, evidence=evidence or action['message']).status_code == (200 if outcome == 'UNKNOWN' else 422)
    if outcome != 'UNKNOWN':
        assert preflight(client, connection, headers, action, stage='send_greeting' if outcome == 'COMMUNICATING' else 'send_resume').status_code == 200
        assert result(client, connection, headers, action, outcome=outcome, receipt_key='old-receipt', evidence=evidence or action['message']).status_code == 422
        assert result(client, connection, headers, action, outcome=outcome, evidence=evidence or action['message']).status_code == 200
    assert client.get('/api/overview').json()['jobs'][0]['status'] == status
    assert claim(client, connection, headers, source, prepared).status_code == 409


def test_wrong_resume_or_ambiguous_receipt_cannot_mark_applied(client):
    connection, headers = setup(client)
    source, prepared = prepare(client, connection, headers)
    approve(client, prepared)
    action = claim(client, connection, headers, source, prepared).json()['action']
    assert preflight(client, connection, headers, action, resume_label='别的简历.pdf').status_code == 409
    assert preflight(client, connection, headers, action).status_code == 200
    assert result(client, connection, headers, action, evidence='本人简历.pdf').status_code == 422
    assert result(client, connection, headers, action, evidence='其他简历.pdf 已发送给BOSS').status_code == 422
    assert result(client, connection, headers, action, evidence='本人简历.pdf 尚未发送成功').status_code == 422
    assert result(client, connection, headers, action, evidence='本人简历.pdf 已发送简历请求，等待同意').status_code == 422
    assert client.get('/api/overview').json()['jobs'][0]['status'] == 'saved'


def test_later_receipt_advances_resume_request_without_authorizing_another_send(client):
    connection, headers = setup(client)
    source, prepared = prepare(client, connection, headers)
    approve(client, prepared)
    action = claim(client, connection, headers, source, prepared).json()['action']
    preflight(client, connection, headers, action)
    assert result(client, connection, headers, action, outcome='RESUME_REQUESTED', evidence='已请求发送简历，请等待对方同意').status_code == 200
    base = '/api/connector/' + connection['connection_id'] + '/applications/'
    waiting = client.get(base + 'receipts', headers=headers).json()['items']
    assert len(waiting) == 1 and 'lease' not in waiting[0]
    assert 'new-receipt' in waiting[0]['baseline_ids']
    body = {'account_label': '测试账号', 'target_verified': True, 'outcome': 'RESUME_SENT', 'receipt_key': 'delivery-receipt', 'evidence': '本人简历.pdf 已发送给BOSS'}
    assert client.post(base + action['id'] + '/sync', headers=headers, json={**body, 'account_label': '别的账号'}).status_code == 403
    assert client.post(base + action['id'] + '/sync', headers=headers, json={**body, 'receipt_key': 'old-receipt'}).status_code == 422
    assert client.post(base + action['id'] + '/sync', headers=headers, json=body).status_code == 200
    assert client.get('/api/overview').json()['jobs'][0]['status'] == 'applied'
    assert client.get(base + 'receipts', headers=headers).json()['items'] == []
    assert claim(client, connection, headers, source, prepared).status_code == 409


def test_manual_interview_status_does_not_regress_and_cancel_does_not_resume(client):
    connection, headers = setup(client)
    source, prepared = prepare(client, connection, headers)
    approve(client, prepared)
    action = claim(client, connection, headers, source, prepared).json()['action']
    assert preflight(client, connection, headers, action).status_code == 200
    client.put('/api/jobs/' + action['job_id'] + '/tracking', json={'status': 'interview', 'notes': '', 'followup_date': ''})
    client.post('/api/applications/' + prepared['batch']['id'] + '/cancel')
    assert result(client, connection, headers, action).status_code == 200
    assert client.get('/api/overview').json()['jobs'][0]['status'] == 'interview'
    assert client.get('/api/applications').json()['batches'][0]['state'] == 'CANCELLED'


def test_expired_lease_is_unknown_and_batch_expiry_cancels_pending(client):
    connection, headers = setup(client)
    source, prepared = prepare(client, connection, headers)
    approve(client, prepared)
    action = claim(client, connection, headers, source, prepared).json()['action']
    with client.app.state.service.store.transaction() as db:
        item = db.get('application_item', action['id']); item['lease_until'] = time.time() - 1; db.put('application_item', item)
    summary = client.get('/api/applications').json()
    assert summary['items'][0]['state'] == 'UNKNOWN' and summary['batches'][0]['state'] == 'NEEDS_REVIEW'
    assert preflight(client, connection, headers, action).status_code == 409
    assert client.get('/api/connector/' + connection['connection_id'] + '/applications', headers=headers).json()['items'] == []


def test_demo_resume_blocks_real_approval_but_can_test_fixture(client):
    connection, headers = pair(client)
    assert client.post('/api/demo').status_code == 200
    client.put('/api/opportunities/preferences', json={'titles': ['Python'], 'cities': ['上海']})
    source = job()
    # Include exactly the demo's documented technology to produce a conservative match.
    value = collect(client, connection, headers, [source]).json()['opportunities'][0]
    response = client.post('/api/applications', json={'connection_id': connection['connection_id'], 'account_label': '测试账号', 'mode': 'greeting', 'opportunity_ids': [value['id']]})
    assert response.status_code == 200
    assert approve(client, response.json()).status_code == 409


def test_search_plan_uses_saved_titles_cities_and_limits(client):
    connection, headers = setup(client, titles=['Python / AI', 'RAG'], cities=['上海', '合肥', '杭州'], search_limit=4, limit=3)
    plan = client.get('/api/opportunities').json()['search_plan']
    assert plan['total'] == 6 and len(plan['entries']) == 4 and plan['per_search_limit'] == 3
    assert [parse_qs(urlsplit(e['url']).query) for e in plan['entries'][:3]] == [
        {'query': ['Python / AI'], 'city': [code]} for code in ['101020100', '101220100', '101210100']]
    paired = client.get('/api/connector/' + connection['connection_id'] + '/search', headers=headers)
    assert paired.json()['search_plan'] == plan
    assert paired.json()['preferences']['search_limit'] == 4
    assert client.get('/api/connector/' + connection['connection_id'] + '/search', headers={'Authorization': 'Bearer wrong'}).status_code == 401


def test_search_plan_without_preferences_or_with_old_preferences(client):
    assert client.get('/api/opportunities').json()['search_plan']['entries'] == []
    setup(client)
    with client.app.state.service.store.transaction() as db:
        prefs = db.get('meta', 'search-preferences')
        prefs.pop('search_limit')
        db.put('meta', prefs)
    data = client.get('/api/opportunities').json()
    assert data['preferences']['search_limit'] == 5 and data['search_plan']['entries']


def test_nationwide_search_still_applies_precise_local_rules(client):
    connection, headers = setup(client, cities=['未配置城市'], min_salary_k=None)
    plan = client.get('/api/opportunities').json()['search_plan']
    assert plan['warnings'] and '100010000' in plan['entries'][0]['url']
    value = collect(client, connection, headers, [job(city='上海')]).json()['opportunities'][0]
    assert value['screening']['result'] == 'excluded'
    client.put('/api/opportunities/preferences', json={'titles': ['Python'], 'cities': [], 'accept_other_cities': True})
    plan = client.get('/api/opportunities').json()['search_plan']
    assert plan['total'] == 1 and plan['warnings'] == [] and plan['entries'][0]['city'] == '全国'


@pytest.mark.parametrize('search_url', ['https://evil.example/web/geek/jobs', 'https://www.zhipin.com/job_detail/role-1.html',
    'https://user@www.zhipin.com/web/geek/jobs', 'https://www.zhipin.com:9999/web/geek/jobs',
    'https://www.zhipin.com/web/geek/jobs#unexpected', 'http://127.0.0.1:8766/boss-fixture'])
def test_invalid_search_source_is_rejected_before_collecting(client, search_url):
    connection, headers = setup(client)
    response = client.post('/api/connector/' + connection['connection_id'] + '/opportunities', headers=headers,
        json={'jobs': [job()], 'search_url': search_url, 'preferences_revision': 1})
    assert response.status_code == 422
    assert client.get('/api/opportunities').json()['opportunities'] == []


def test_search_revision_changes_stop_remaining_collection(client):
    connection, headers = setup(client)
    old_revision = client.get('/api/opportunities').json()['preferences']['revision']
    client.put('/api/opportunities/preferences', json={'titles': ['Python'], 'cities': ['杭州']})
    response = client.post('/api/connector/' + connection['connection_id'] + '/opportunities', headers=headers,
        json={'jobs': [job()], 'preferences_revision': old_revision})
    assert response.status_code == 409
    assert client.get('/api/opportunities').json()['opportunities'] == []


def test_search_sources_survive_cross_city_batch_and_are_frozen_for_approval(client):
    connection, headers = setup(client, cities=['上海', '杭州'])
    summary = client.get('/api/opportunities').json()
    selected, sources = [], []
    for n, entry in enumerate(summary['search_plan']['entries']):
        source = job('city-' + str(n), city=entry['city'])
        response = client.post('/api/connector/' + connection['connection_id'] + '/opportunities', headers=headers,
            json={'jobs': [source], 'search_url': entry['url'], 'preferences_revision': summary['preferences']['revision']})
        assert response.status_code == 200
        value = response.json()['opportunities'][0]
        assert value['search_url'] == entry['url']
        selected.append(value['id']); sources.append(source)
    prepared = client.post('/api/applications', json={'connection_id': connection['connection_id'], 'account_label': '测试账号',
        'opportunity_ids': selected, 'mode': 'resume', 'resume_label': '本人简历.pdf'}).json()
    assert [i['search_url'] for i in prepared['items']] == [e['url'] for e in summary['search_plan']['entries']]
    assert approve(client, prepared).status_code == 200
    ready = client.get('/api/connector/' + connection['connection_id'] + '/applications', headers=headers).json()
    assert [i['search_url'] for i in ready['items']] == [i['search_url'] for i in prepared['items']]
    for source in sources:
        action = claim(client, connection, headers, source, prepared).json()['action']
        assert preflight(client, connection, headers, action).status_code == 200
        assert result(client, connection, headers, action).status_code == 200
    assert all(j['status'] == 'applied' for j in client.get('/api/overview').json()['jobs'])
    assert client.get('/api/applications').json()['batches'][0]['state'] == 'DONE'


def test_changed_search_source_invalidates_batch_digest(client):
    connection, headers = setup(client)
    source, prepared = prepare(client, connection, headers)
    with client.app.state.service.store.transaction() as db:
        item = db.get('application_item', prepared['items'][0]['id'])
        item['search_url'] = 'https://www.zhipin.com/web/geek/jobs?query=changed'
        db.put('application_item', item)
    assert approve(client, prepared).status_code == 409

