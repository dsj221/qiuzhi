import base64
import hashlib
import hmac
import time

import httpx
import pytest

from job_agent import followups
from test_boss_connector import client, pair


@pytest.fixture
def follow(client, monkeypatch):
    notices = []
    monkeypatch.setattr(followups, 'send_notice', lambda rule, msg: notices.append(msg) or ('sent', ''))
    connection, headers = pair(client)
    key = connection['connection_id']
    admin = '/api/boss/connections/' + key + '/followup'
    rule = dict(enabled=True, confirmation='automatic', account_label='本人', message='谢谢回复', resume_label='实习简历.pdf',
                webhook='https://open.feishu.cn/open-apis/bot/v2/hook/12345678-12345678')
    assert client.put(admin, json=rule).status_code == 200
    store = client.app.state.service.store
    with store.transaction() as db:
        db.put('job', dict(id='job', status='communicating', history=[]))
        db.put('application_batch', dict(id='batch', account_label='本人'))
        db.put('application_item', dict(id='item', connection_id=key, job_id='job', batch_id='batch', state='COMMUNICATING',
                                       source='boss', title='实习', company='测试公司', finished_at=time.time(), receipt_key='hi'))
    path = '/api/connector/' + key + '/followup'
    rev = client.get(path, headers=headers).json()['revision']

    def scan(*rows, **extra):
        body = dict(item_id='item', account_label='本人', contact='测试公司 HR', revision=rev,
                    messages=[dict(id=r, role='me' if r in {'hi', 'my-reply'} else 'recruiter') for r in rows])
        return client.post(path+'/scan', headers=headers, json={**body, **extra})

    def progress(action, stage, outcome, **kwargs):
        return client.post(path+'/progress', headers=headers, json=dict(item_id='item', lease=action['lease'],
                                                                         stage=stage, outcome=outcome, **kwargs))
    return scan, progress, store, admin, rule, notices


def test_followup_once_and_later_messages_notify(client, follow):
    scan, progress, store, admin, _, notices = follow
    first = scan('hi', 'hr1', 'hr2').json()['action']
    assert first['send_resume'] and first['trigger'] == 'hr2'
    assert not scan('hi', 'hr1', 'hr2').json()['action']
    assert progress(first, 'resume', 'check').status_code == 409
    assert progress(first, 'reply', 'check').is_success
    assert progress(first, 'reply', 'check').status_code == 409
    assert progress(first, 'reply', 'sent', evidence='谢谢回复', receipt_key='my-reply').is_success
    assert progress(first, 'resume', 'check').is_success
    assert progress(first, 'resume', 'sent', evidence='其他简历.pdf 已发送', receipt_key='file').status_code == 409
    assert progress(first, 'resume', 'sent', evidence='实习简历.pdf 已发送', receipt_key='file').is_success
    assert not scan('hr2', 'my-reply', 'hr3').json()['action']
    while followups.deliver_next(client.app.state.service):
        pass
    assert [e['count'] for e in client.get(admin).json()['events']] == [1, 2]
    assert len(notices) == 2 and '2 条新回复' in notices[0]
    with store.transaction() as db:
        assert db.get('job', 'job')['status'] == 'applied'


def test_baseline_discontinuity_manual_reply_and_wrong_contact(client, follow):
    scan, _, store, admin, _, _ = follow
    with store.transaction() as db:
        item = db.get('application_item', 'item')
        db.put('application_item', {**item, 'finished_at': 1})
    assert not scan('hi', 'historic').json()['action']
    assert '上次消息' in scan('unrelated').json()['status']
    assert scan('historic', 'other', contact='另一位HR').status_code == 409
    assert scan('historic', 'other', account_label='另一个账号').status_code == 409
    assert not scan('hi', 'historic', 'new', 'my-reply').json()['action']
    result = client.get(admin).json()
    assert len(result['events']) == 1 and result['actions'][0]['reply'] == 'manual'


def test_disable_or_change_blocks_old_action_and_secret_is_private(client, follow):
    scan, progress, _, admin, rule, _ = follow
    action = scan('hi', 'new', resume_seen=True).json()['action']
    assert not action['send_resume']
    assert client.put(admin, json={**rule, 'webhook':'https://example.test/invalid'}).status_code == 422
    response = client.put(admin, json={**rule, 'webhook':'', 'secret':'private-sign', 'enabled':False})
    assert 'private-sign' not in response.text and rule['webhook'] not in client.get(admin).text
    assert progress(action, 'reply', 'check').status_code == 409
    assert scan('hi','new','another').status_code == 409


def test_unknown_or_requested_never_resends(client, follow):
    scan, progress, _, admin, _, _ = follow
    action = scan('hi','new').json()['action']
    assert progress(action, 'reply', 'check').is_success
    assert progress(action, 'reply', 'sent', receipt_key='my-reply', evidence='谢谢回复').is_success
    assert progress(action, 'resume', 'check').is_success
    assert progress(action, 'resume', 'requested', receipt_key='request', evidence='已请求对方同意接收简历').is_success
    assert not scan('new', 'my-reply', 'more').json()['action']
    assert client.get(admin).json()['actions'][0]['resume'] == 'requested'
    assert not scan('more', delivered_id='new-file', delivered_evidence='实习简历.pdf 已发送给BOSS').json()['action']
    assert client.get(admin).json()['actions'][0]['resume'] == 'sent'


def test_signed_feishu_delivery_and_api_error(monkeypatch):
    sent = []
    monkeypatch.setattr(followups, 'getproxies', lambda: {'https':'http://proxy.test:3128','all':'socks5h://proxy.test:1080'})
    monkeypatch.setattr(followups, 'proxy_bypass', lambda host: False)
    class Transport:
        def __init__(self, **kwargs): assert not kwargs['follow_redirects'] and kwargs['proxy']=='http://proxy.test:3128'
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def post(self, url, json):
            sent.append(json)
            return httpx.Response(200, json={'code':0 if len(sent)==1 else 19024})
    monkeypatch.setattr(followups.httpx, 'Client', Transport)
    rule={'webhook':'https://open.feishu.cn/open-apis/bot/v2/hook/example', 'secret':'secret'}
    assert followups.send_notice(rule,'求职提醒') == ('sent','')
    signature = hmac.new((sent[0]['timestamp']+'\nsecret').encode(), digestmod=hashlib.sha256).digest()
    assert sent[0]['sign'] == base64.b64encode(signature).decode()
    status, detail = followups.send_notice(rule,'求职提醒')
    assert status == 'failed' and '19024' in detail and '关键词' in detail
    assert rule['webhook'] not in detail and rule['secret'] not in detail


def test_current_attachment_and_repeat_rounds(client, follow):
    scan, progress, store, admin, rule, notices = follow
    assert client.put(admin, json={**rule, 'resume_label':'', 'later_message':'收到，谢谢！'}).is_success
    with store.transaction() as db:
        revision=db.all('follow_rule')[0]['revision']
    assert not scan('hi',revision=revision).json()['action']
    action=scan('hi','hr1',revision=revision,messages=[
        {'id':'hi','role':'me'},{'id':'hr1','role':'recruiter','text':'可以发一份简历吗？'}]).json()['action']
    assert action['direct_resume'] and action['send_resume']
    assert progress(action,'reply','check').is_success
    assert progress(action,'reply','sent', receipt_key='my-reply', evidence=rule['message']).is_success
    assert progress(action,'resume','check',baseline_ids=['old']).is_success
    assert progress(action,'resume','sent',receipt_key='old',evidence='已发送附件简历').status_code==409
    assert progress(action,'resume','sent',receipt_key='file',evidence='确定向 Boss 发送简历吗？').status_code==409
    assert progress(action,'resume','sent',receipt_key='file',evidence='附件卡片：项目简历.pdf').is_success
    next_action=scan('hr1','my-reply','hr2',revision=revision).json()['action']
    assert next_action['message']=='收到，谢谢！' and not next_action['send_resume']
    assert not scan('hr1','my-reply','hr2',revision=revision).json()['action']
    while followups.deliver_next(client.app.state.service):
        pass
    assert len(notices)==2 and all('可以发一份简历吗' not in msg for msg in notices)
    assert client.get(admin).json()['events'][-1]['preview']=='可以发一份简历吗？'


def test_personal_confirmation_is_reconciled_from_chat(client, follow):
    scan, progress, _, admin, rule, _ = follow
    settings = {**rule, "confirmation": "personal", "resume_label": ""}
    assert client.put(admin, json=settings).is_success
    key = admin.split("/")[4]
    with client.app.state.service.store.transaction() as db:
        revision = db.get("follow_rule", key)["revision"]
    assert not scan("hi", revision=revision).json()["action"]
    action = scan("hi", "hr", revision=revision).json()["action"]
    assert action["confirmation"] == "personal"
    assert progress(action, "reply", "check").is_success
    assert progress(action, "reply", "sent", evidence=rule["message"], receipt_key="my-reply").is_success
    assert progress(action, "resume", "check").status_code == 409
    assert progress(action, "resume", "check", personal_confirmation=True, baseline_ids=["hi", "hr", "my-reply"]).is_success
    assert client.get(admin).json()["actions"][0]["resume"] == "awaiting_confirmation"
    assert not scan("hr", "my-reply", revision=revision, delivered_id="file", delivered_evidence="已发送附件简历").json()["action"]
    assert client.get(admin).json()["actions"][0]["resume"] == "sent"
