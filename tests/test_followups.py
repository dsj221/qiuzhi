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
    rule = dict(enabled=True, reply_mode='template', confirmation='automatic', account_label='本人', message='谢谢回复', resume_label='实习简历.pdf',
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


def test_ai_generates_without_templates_retries_and_replies_once(client, follow, monkeypatch):
    scan, progress, store, admin, rule, _ = follow
    configured = client.put(admin, json={**rule, 'reply_mode':'ai', 'message':'', 'later_message':''})
    assert configured.json()['reply_mode'] == 'ai'
    key = admin.split('/')[4]
    with store.transaction() as db:
        revision = db.get('follow_rule', key)['revision']
    calls = []

    def generate(title, history, previous):
        calls.append((title, history, previous))
        if len(calls) == 1:
            raise followups.MatchError('模型暂时不可用', 503)
        return ('请问团队目前最希望解决哪类技术问题？', False) if not previous else ('谢谢介绍项目方向。', True)

    monkeypatch.setattr(client.app.state.service.model, 'recruiter_reply', generate)
    rows = [{'id':'hi','role':'me'}]
    def read():
        return scan(revision=revision, messages=rows).json()
    assert not read()['action']
    rows.append({'id':'hr','role':'recruiter','text':'聊聊技术方向？联系 13812345678'})
    assert not read()['action']
    assert not read()['action'] and len(calls) == 1
    with store.transaction() as db:
        w = db.get('follow_watch','item')
        w['ai_pending']['next_attempt'] = 0
        db.put('follow_watch',w)
    first = read()['action']
    assert first['send_resume'] and '技术' in first['message']
    assert '13812345678' not in str(calls)
    assert not read()['action']
    assert progress(first,'reply','check').is_success
    assert progress(first,'reply','sent',receipt_key='me1',evidence=first['message']).is_success
    rows.extend([{'id':'me1','role':'me'}, {'id':'hr2','role':'recruiter','text':'谢谢，职位已关闭'}])
    later = read()['action']
    assert later['trigger'] == 'hr2' and not later['send_resume']
    assert calls[-1][2] == first['message']
    assert len(client.get(admin).json()['events']) == 2


def test_ai_discards_generation_if_disabled_mid_request(client, follow, monkeypatch):
    scan, _, store, admin, rule, _ = follow
    settings = {**rule, 'reply_mode':'ai'}
    assert client.put(admin,json=settings).is_success
    with store.transaction() as db:
        revision = db.get('follow_rule',admin.split('/')[4])['revision']
    assert not scan('hi',revision=revision).json()['action']
    def generate(*args):
        assert client.put(admin,json={**settings,'enabled':False}).is_success
        return '收到，谢谢。', False
    monkeypatch.setattr(client.app.state.service.model,'recruiter_reply',generate)
    rows = [{'id':'hi','role':'me'}, {'id':'hr','role':'recruiter','text':'你好'}]
    assert not scan(messages=rows,revision=revision).json()['action']


def test_model_generates_contextual_text_and_rejects_contact_data(monkeypatch):
    from job_agent.model import Model, MatchError
    model = Model()
    responses = iter([
        {'message':'请问这个岗位主要负责哪部分产品研发？', 'closing':False},
        {'message':'请联系我 13812345678。', 'closing':False},
    ])
    def respond(task, payload):
        assert payload['最近的双方聊天'] == ['岗位偏产品研发，你感兴趣吗？']
        assert '收到您的介绍' == payload['上次已发送的回复']
        return next(responses)
    monkeypatch.setattr(model,'match_response',respond)
    args = ('产品研发',['岗位偏产品研发，你感兴趣吗？'],'收到您的介绍')
    assert model.recruiter_reply(*args) == ('请问这个岗位主要负责哪部分产品研发？', False)
    with pytest.raises(MatchError):
        model.recruiter_reply(*args)


def test_manual_thread_baseline_recovery_and_no_duplicate_delivery(client):
    pair_data, headers = pair(client)
    key = pair_data['connection_id']
    admin = '/api/boss/connections/'+key+'/followup'
    rule = dict(enabled=True, reply_mode='template', account_label='本人', confirmation='automatic',
                message='收到，请问具体方向？', resume_label='', later_message='谢谢介绍。',
                webhook='https://open.feishu.cn/open-apis/bot/v2/hook/12345678-12345678')
    assert client.put(admin,json=rule).is_success
    path = '/api/connector/'+key+'/followup'
    plan = client.get(path,headers=headers).json()
    assert plan['current_chat'] and not plan['items']
    rows = [dict(id='r0',role='recruiter',text='你好'),dict(id='m1',role='me'),
            dict(id='r1',role='recruiter',text='方便发一份简历吗？')]
    def scan(**fields):
        return client.post(path+'/current',headers=headers,json=dict(
            title='软件工程师', company='猎头顾问', contact='测试招聘方',account_label='本人',
            revision=plan['revision'],messages=rows, **fields))
    assert scan().json()['action'] is None
    action = scan(catch_up=True).json()['action']
    assert action['thread_anchor']=='m1' and not action['send_resume']
    assert scan(catch_up=True).json()['action'] is None
    for payload in [dict(outcome='check'),dict(outcome='sent',evidence=rule['message'],receipt_key='m2')]:
        assert client.post(path+'/progress',headers=headers,json=dict(stage='reply',item_id=action['id'],lease=action['lease'],**payload)).is_success
    assert len(client.get(admin).json()['events'])==1
    rows.pop(1)
    assert scan().status_code==409


def test_opened_chat_archives_both_speakers_and_answers_unanswered_turn_once(client, follow, monkeypatch):
    _, _, _, _, rule, _ = follow
    # Use the normal connector login, with a separate pair and no application items.
    pair_data, headers = pair(client)
    key = pair_data['connection_id']
    admin = '/api/boss/connections/'+key+'/followup'
    assert client.put(admin,json={**rule,'reply_mode':'ai'}).is_success
    path = '/api/connector/'+key+'/followup'
    revision = client.get(path,headers=headers).json()['revision']
    payload = dict(opened_chat=True,title='软件工程师',company='测试公司',contact='甲',account_label='本人',revision=revision)
    def read(rows, **changes):
        return client.post(path+'/current',headers=headers,json={**payload,**changes,'messages':[
            dict(id=i,role=r,text=t) for i,r,t in rows]}).json()
    calls = []
    def generate(title,history,previous):
        calls.append(history)
        return '请问具体负责哪部分研发工作？', False
    monkeypatch.setattr(client.app.state.service.model,'recruiter_reply',generate)
    rows = [('a','me','我之前做过后端研发'),('b','recruiter','具体方向是研发，你希望了解什么？')]
    assert 'action' not in read(rows,drafting=True)
    action = read(rows)['action']
    assert action['trigger']=='b' and not action['send_resume']
    assert [r['speaker'] for r in calls[0]]==['本人','HR']
    assert read(rows)['action'] is None
    for outcome in [dict(outcome='check'),dict(outcome='sent',receipt_key='c',evidence=action['message'])]:
        assert client.post(path+'/progress',headers=headers,json=dict(stage='reply',item_id=action['id'],lease=action['lease'],**outcome)).is_success
    rows.append(('c','me',action['message']))
    assert read(rows)['action'] is None
    assert '较早' in read([('old','recruiter','你好'),*rows[:2]])['status']
    history=client.get(admin+'/history').json()['threads']
    assert len(history)==1 and [m['id'] for m in history[0]['messages']]==['old','a','b','c']
    assert len(calls)==1
    # First inbound-only conversation is independent and needs no manual greeting.
    fresh=read([('other','recruiter','方便聊聊岗位方向吗？')],contact='乙')['action']
    assert fresh['thread_anchor']=='other' and fresh['id']!=action['id']


@pytest.mark.parametrize('fresh_greeting', [True, False])
def test_first_opened_reply_preserves_attachment_decision_across_ai_retry(client, follow, monkeypatch, fresh_greeting):
    scan, progress, store, admin, rule, notices = follow
    assert client.put(admin, json={**rule, 'reply_mode':'ai'}).is_success
    with store.transaction() as db:
        revision = db.get('follow_rule', admin.split('/')[4])['revision']
    with store.transaction() as db:
        item = db.get('application_item', 'item')
        item['finished_at'] = time.time() if fresh_greeting else 0
        db.put('application_item', item)
    calls = []
    def generate(*args):
        calls.append(args)
        if len(calls) == 1:
            raise followups.MatchError('网络暂时不可用', 503)
        return '谢谢介绍，请问团队目前的重点项目是什么？', False
    monkeypatch.setattr(client.app.state.service.model, 'recruiter_reply', generate)
    rows = [dict(id='hi', role='me', text='您好'), dict(id='hr', role='recruiter', text='方便聊聊吗')]
    def read():
        return scan(messages=rows, revision=revision, opened_chat=True).json()
    assert read()['action'] is None
    with store.transaction() as db:
        watch = db.get('follow_watch','item')
        watch['ai_pending']['next_attempt'] = 0
        db.put('follow_watch',watch)
    action = read()['action']
    assert action['send_resume'] is fresh_greeting
    assert read()['action'] is None
    assert len(calls) == 2
    assert progress(action, 'reply', 'check').is_success
    assert progress(action, 'reply', 'sent', evidence=action['message'], receipt_key='my-reply').is_success
    assert len(client.get(admin).json()['events']) == 1


def test_screen_to_greeting_to_hr_reply_and_delivery(client, monkeypatch):
    from test_opportunities import setup, job, collect
    pair_data, headers = setup(client)
    key = pair_data['connection_id']
    route = '/api/connector/' + key
    admin = '/api/boss/connections/' + key
    def post(path, payload):
        response = client.post(route + path, headers=headers, json=payload)
        assert response.is_success, response.text
        return response.json()

    notices = []
    def notify(rule, text):
        notices.append(text)
        return 'sent', ''
    monkeypatch.setattr(followups, 'send_notice', notify)
    service = client.app.state.service
    monkeypatch.setattr(service.model, 'recruiter_reply', lambda *args: ('谢谢介绍，方便聊聊团队吗？', False))
    monkeypatch.setattr(client.app.state.opportunities, 'screen', lambda *args: {
        'result':'matched', 'requirements':[], 'report':{'engine':'model'}})
    assert client.put(admin+'/auto-greeting',json={'account_label':'本人'}).is_success
    assert client.put(admin+'/followup',json=dict(enabled=True,reply_mode='ai',account_label='本人',message='',resume_label='',
        confirmation='automatic',webhook='https://open.feishu.cn/open-apis/bot/v2/hook/12345678-12345678')).is_success
    listing = job()
    op = collect(client,pair_data,headers,[listing]).json()['opportunities'][0]
    draft = post('/applications/drafts',dict(opportunity_ids=[op['id']],account_label='本人',mode='greeting',
        resume_revision=op['resume_revision'],preferences_revision=op['preferences_revision']))
    batch, = draft['batches']
    post('/applications/'+batch+'/dispatch',{})
    target = post('/applications/claim',dict(batch_id=batch,account_label='本人',job=listing))['action']
    prefix = '/applications/'+target['id']
    for stage in ['open_chat','send_greeting']:
        post(prefix+'/preflight',dict(lease=target['lease'],stage=stage,account_label='本人',target_verified=True,message_ids=[]))
    assert post(prefix+'/result',dict(lease=target['lease'],outcome='COMMUNICATING',
        evidence=target['message'],receipt_key='hello'))['batch_state']=='DONE'
    plan = client.get(route+'/followup',headers=headers).json()
    assert [item['id'] for item in plan['items']]==[target['id']]
    payload = dict(item_id=target['id'],revision=plan['revision'],account_label='本人',contact='测试 HR',opened_chat=True,
        messages=[dict(id='hello',role='me',text=target['message']),dict(id='hr',role='recruiter',text='请发简历')])
    action = post('/followup/scan',payload)['action']
    assert action['send_resume']
    for stage, key_id, evidence in [('reply','answer',action['message']),('resume','file','附件卡片：简历.pdf')]:
        base=dict(item_id=target['id'],lease=action['lease'],stage=stage)
        post('/followup/progress',dict(**base,outcome='check'))
        post('/followup/progress',dict(**base,outcome='sent',receipt_key=key_id,evidence=evidence))
    assert post('/followup/scan',payload)['action'] is None
    followups.deliver_next(service)
    assert len(notices)==1
    with service.store.transaction() as db:
        assert db.get('job',target['job_id'])['status']=='applied'
        assert len(db.get('follow_history',target['id'])['messages'])==2
