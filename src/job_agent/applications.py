"""Reviewed, bounded application batches with explicit platform evidence."""
import re
import secrets
import time
import uuid
from typing import List, Literal, Optional

from fastapi import Depends, Request
from pydantic import BaseModel, Field

from .model import INTENT_VERSION
from .opportunities import DiscoveredJob, canonical, validate_search_url
from .privacy import redact
from .service import require


def delivered(evidence, label):
    remainder = evidence.replace(label, '')
    return bool(label and label in evidence and re.search(r'已发送|发送成功|发送给', remainder) and not re.search(r'未发送|发送失败|尚未发送|没有发送|请求|申请|等待.*同意', remainder))


GREETING_TEMPLATE = '您好，我关注到贵公司的“{岗位}”岗位，希望进一步了解岗位职责。'


class GreetingRule(BaseModel):
    account_label: str = Field(max_length=160)


class BatchInput(BaseModel):
    opportunity_ids: List[str] = Field(min_length=1, max_length=10)
    connection_id: str
    account_label: str = Field(min_length=1, max_length=160)
    mode: Literal['greeting', 'resume'] = 'resume'
    resume_label: str = Field(default='', max_length=160)
    message_template: str = Field(default=GREETING_TEMPLATE, min_length=4, max_length=3000)


class AutomaticDraftInput(BaseModel):
    opportunity_ids: List[str] = Field(max_length=400)
    preferences_revision: int
    resume_revision: int
    account_label: str = Field(min_length=1, max_length=160)
    mode: Literal['greeting', 'resume']
    resume_label: str = Field(default='', max_length=160)
    message_template: str = Field(default=GREETING_TEMPLATE, min_length=4, max_length=3000)


class ApprovalInput(BaseModel):
    digest: str
    targets_confirmed: bool
    resume_confirmed: bool


class ApplicationClaim(BaseModel):
    batch_id: str
    job: DiscoveredJob
    account_label: str = Field(min_length=1, max_length=160)


class PreflightInput(BaseModel):
    lease: str
    stage: Literal['open_chat', 'send_greeting', 'send_resume']
    account_label: str
    target_verified: bool
    message_ids: List[str] = Field(default_factory=list, max_length=500)
    resume_label: str = Field(default='', max_length=160)


class ApplicationResult(BaseModel):
    lease: str
    outcome: Literal['COMMUNICATING', 'RESUME_REQUESTED', 'RESUME_SENT', 'ALREADY_CONTACTED', 'NEEDS_USER', 'UNKNOWN', 'FAILED']
    receipt_key: Optional[str] = Field(default=None, max_length=200)
    evidence: str = Field(default='', max_length=6000)
    reason: str = Field(default='', max_length=500)


class ReceiptSync(BaseModel):
    account_label: str = Field(max_length=160)
    target_verified: bool
    outcome: Literal['COMMUNICATING', 'RESUME_REQUESTED', 'RESUME_SENT', 'ALREADY_CONTACTED']
    receipt_key: str = Field(min_length=1, max_length=200)
    evidence: str = Field(min_length=1, max_length=6000)


class Applications:
    def __init__(self, service, connector, opportunities):
        self.service, self.connector, self.opportunities = service, connector, opportunities
        with service.store.transaction() as db:
            for batch in db.all('application_batch'):
                if batch['state'] in {'DRAFT', 'APPROVED', 'RUNNING'} and batch.get('matching_version') != INTENT_VERSION:
                    batch['state'] = 'NEEDS_REVIEW'
                    db.put('application_batch', batch)
                    for pending in db.all('application_item'):
                        if pending['batch_id'] == batch['id'] and pending['state'] in {'DRAFT', 'PENDING'}:
                            pending.update(state='CANCELLED', reason='已切换到 API 匹配，请重新筛选')
                            db.put('application_item', pending)
            for item in db.all('application_item'):
                if item['state'] == 'RUNNING':
                    item.update(state='UNKNOWN', reason='服务重启前的执行结果不明，请查看平台，不会自动重试')
                    db.put('application_item', item)
                    batch = db.get('application_batch', item['batch_id'])
                    if batch:
                        batch['state'] = 'NEEDS_REVIEW'
                        db.put('application_batch', batch)

    def manifest(self, batch, items):
        return canonical({'mode': batch['mode'], 'resume_label': batch['resume_label'], 'account_label': batch['account_label'],
                          'resume_revision': batch['resume_revision'], 'preferences_revision': batch['preferences_revision'],
                          'targets': [{**{k: item[k] for k in ('opportunity_id', 'external_id', 'url', 'title', 'company', 'message', 'content_hash')},
                                       **({'search_url': item['search_url']} if item.get('search_url') else {})} for item in items]})

    def create(self, data):
        with self.service.store.transaction() as db:
            return self.create_in(db, data)

    def set_greeting_rule(self, key, account_label):
        with self.service.store.transaction() as db:
            connection = self.service.entity(db, 'boss_connection', key)
            require(not connection['revoked'], '连接已撤销')
            connection['auto_greeting_account'] = account_label.strip()
            db.put('boss_connection', connection)
            return {'account_label': connection['auto_greeting_account']}

    def prepare_automatic(self, key, token, request):
        with self.service.store.transaction() as db:
            connection = self.connector.authenticate(db, key, token)
            profile = db.get('profile', 'me')
            require(profile and profile['revision'] == request.resume_revision and
                    self.opportunities.preferences(db)['revision'] == request.preferences_revision,
                    '简历或筛选条件已更新，请按新版本重新搜索')
            prior = {(i['source'], i['external_id']) for i in db.all('application_item')
                     if i['state'] not in {'CANCELLED', 'FAILED', 'NEEDS_USER'} or i.get('preflight_at')}
            saved = {(j.get('source'), j.get('boss_external_id')): j['status'] for j in db.all('job')}
            eligible = []
            for oid in dict.fromkeys(request.opportunity_ids):
                op = self.service.entity(db, 'opportunity', oid)
                require(op['source'] == 'boss' and op['connection_id'] == key, '只能准备本连接搜索到的真实岗位')
                identity = ('boss', op['external_id'])
                if identity not in prior and saved.get(identity, 'saved') == 'saved':
                    eligible.append(oid)
            direct = (request.mode == 'greeting' and request.account_label == connection.get('auto_greeting_account')
                      and request.message_template == GREETING_TEMPLATE and not request.resume_label.strip())
            batches = []
            options = request.model_dump(exclude={'opportunity_ids', 'preferences_revision', 'resume_revision'})
            for start in range(0, len(eligible), 10):
                data = dict(options, connection_id=key, opportunity_ids=eligible[start:start+10], automatic=True)
                prepared = self.create_in(db, data)
                batch = prepared['batch']
                if direct:
                    batch['auto_greeting'] = True
                    self.activate(db, batch, prepared['items'], profile)
                batches.append(batch['id'])
            return {'batches': batches, 'eligible': len(eligible), 'auto_greeting': direct}

    def create_in(self, db, data):
        require(len(set(data['opportunity_ids'])) == len(data['opportunity_ids']), '同一岗位不能重复加入批次', 422)
        require(data['mode'] != 'resume' or bool(data['resume_label'].strip()), '请填写本次在BOSS使用的准确简历名称', 422)
        connection = self.service.entity(db, 'boss_connection', data['connection_id'])
        require(not connection['revoked'], '连接已撤销')
        profile = db.get('profile', 'me')
        require(profile is not None, '请先保存我的简历')
        prefs = self.opportunities.preferences(db)
        batch_id = uuid.uuid4().hex
        batch = {'id': batch_id, **data, 'matching_version': INTENT_VERSION, 'state': 'DRAFT', 'resume_revision': profile['revision'],
                 'preferences_revision': prefs['revision'], 'created_at': time.time()}
        items = []
        for key in data['opportunity_ids']:
            opportunity = self.service.entity(db, 'opportunity', key)
            require(opportunity['connection_id'] == connection['id'], '所选岗位来自不同连接，请分批处理')
            require(opportunity.get('matching_version') == INTENT_VERSION and
                    (opportunity['screening'].get('report') or {}).get('engine') == 'model', '请使用匹配 API 重新筛选岗位')
            require(not opportunity.get('jd_outdated'), '岗位JD已更新，请重新采集并筛选')
            require(opportunity['screening']['result'] == 'matched', '只允许将符合已设筛选条件的岗位加入自动投递')
            require(opportunity['resume_revision'] == profile['revision'] and opportunity['preferences_revision'] == prefs['revision'], '岗位匹配已过期，请重新筛选')
            job = self.opportunities.favorite_in(db, opportunity)
            require(job['status'] == 'saved', '此岗位已有投递或沟通记录，不能自动重复投递')
            require(not any(i['external_id'] == opportunity['external_id'] and i['source'] == opportunity['source'] and i['state'] not in {'CANCELLED', 'FAILED', 'NEEDS_USER'} for i in db.all('application_item')), '此岗位已在投递队列或有待核对结果，不能重复加入')
            db.put('opportunity', opportunity)
            item = {k: opportunity[k] for k in ('external_id', 'url', 'title', 'company', 'content_hash', 'source')}
            validate_search_url(opportunity.get('search_url', ''), opportunity['source'])
            item['search_url'] = opportunity.get('search_url', '')
            item.update(id=uuid.uuid4().hex, batch_id=batch_id, opportunity_id=key, job_id=job['id'], connection_id=connection['id'], state='DRAFT',
                        mode=data['mode'], resume_label=data['resume_label'].strip(), message=data['message_template'].replace('{岗位}', opportunity['title']).replace('{公司}', opportunity['company']), created_at=time.time())
            db.put('application_item', item)
            items.append(item)
        batch['digest'] = self.manifest(batch, items)
        db.put('application_batch', batch)
        return {'batch': batch, 'items': items}

    def current(self, db, batch):
        profile = db.get('profile', 'me')
        prefs = self.opportunities.preferences(db)
        require(profile and profile['revision'] == batch['resume_revision'] and prefs['revision'] == batch['preferences_revision'], '简历或筛选条件已变化，请重新准备并确认批次')
        if batch.get('auto_greeting'):
            connection = self.service.entity(db, 'boss_connection', batch['connection_id'])
            require(connection.get('auto_greeting_account') == batch['account_label'], '该账号的自动打招呼已关闭')
        return profile

    def approve(self, key, data):
        require(data['targets_confirmed'] and data['resume_confirmed'], '请核对具体岗位、BOSS账号、消息及要使用的简历后确认', 422)
        with self.service.store.transaction() as db:
            batch = self.service.entity(db, 'application_batch', key)
            require(batch['state'] == 'DRAFT', '该批次不能重复确认')
            profile = self.current(db, batch)
            items = [i for i in db.all('application_item') if i['batch_id'] == key]
            require(secrets.compare_digest(batch['digest'], data['digest']) and batch['digest'] == self.manifest(batch, items), '批次内容发生变化，请重新核对')
            self.activate(db, batch, items, profile)
            return {'ok': True}

    def activate(self, db, batch, items, profile):
        if any(i['source'] == 'boss' for i in items):
            require(not profile.get('is_demo') and profile.get('name') != '演示求职者', '演示简历不能用于真实投递，请保存本人真实简历')
        batch.update(state='APPROVED', approved_at=time.time(), expires_at=time.time() + 15 * 60)
        db.put('application_batch', batch)
        for item in items:
            item['state'] = 'PENDING'
            db.put('application_item', item)

    def cancel(self, key):
        with self.service.store.transaction() as db:
            batch = self.service.entity(db, 'application_batch', key)
            batch['state'] = 'CANCELLED'
            db.put('application_batch', batch)
            for item in db.all('application_item'):
                if item['batch_id'] == key and item['state'] in {'DRAFT', 'PENDING', 'RUNNING'}:
                    item['state'] = 'UNKNOWN' if item['state'] == 'RUNNING' else 'CANCELLED'
                    db.put('application_item', item)
        return {'ok': True}

    def sweep(self):
        """Expired work pauses once, and is never made pending again."""
        now = time.time()
        with self.service.store.transaction() as db:
            for batch in db.all('application_batch'):
                items = [i for i in db.all('application_item') if i['batch_id'] == batch['id']]
                timed_out = [i for i in items if i['state'] == 'RUNNING' and i.get('lease_until', 0) < now]
                expired = batch['state'] in {'APPROVED', 'RUNNING'} and batch.get('expires_at', 0) < now
                for item in items:
                    if item in timed_out or (expired and item['state'] == 'RUNNING'):
                        item.update(state='UNKNOWN', reason='执行超时，结果待核对，不会自动重试')
                        db.put('application_item', item)
                    elif expired and item['state'] == 'PENDING':
                        item.update(state='CANCELLED', reason='批次确认已过期')
                        db.put('application_item', item)
                if expired:
                    batch['state'] = 'EXPIRED'
                    db.put('application_batch', batch)
                elif timed_out and batch['state'] not in {'CANCELLED', 'EXPIRED'}:
                    batch['state'] = 'NEEDS_REVIEW'
                    db.put('application_batch', batch)

    def summary(self):
        self.sweep()
        with self.service.store.transaction() as db:
            return {'batches': db.all('application_batch')[::-1], 'items': [{k: v for k, v in i.items() if k != 'lease'} for i in db.all('application_item')][::-1]}

    def ready(self, key, token):
        self.sweep()
        with self.service.store.transaction() as db:
            self.connector.authenticate(db, key, token)
            batches = [b for b in db.all('application_batch') if b['connection_id'] == key and b['state'] in {'APPROVED', 'RUNNING'} and b['expires_at'] > time.time()]
            ids = {b['id'] for b in batches}
            items = [{**{k: i[k] for k in ('id', 'batch_id', 'external_id', 'url', 'title', 'company', 'mode', 'resume_label', 'state')},
                      'search_url': i.get('search_url', '')} for i in db.all('application_item') if i['batch_id'] in ids and i['state'] == 'PENDING']
            drafts = [{'id': b['id'], 'account_label': b['account_label']} for b in db.all('application_batch')
                      if b['connection_id'] == key and b.get('automatic') and b['state'] == 'DRAFT']
            return {'batches': batches, 'items': items, 'drafts': drafts}

    def dispatch(self, key, token, batch_id):
        self.sweep()
        with self.service.store.transaction() as db:
            self.connector.authenticate(db, key, token)
            batch = self.service.entity(db, 'application_batch', batch_id)
            require(batch['connection_id'] == key and batch.get('automatic') and batch['state'] == 'APPROVED'
                    and not batch.get('dispatched_at'), '该批次已领取或需要重新核对')
            self.current(db, batch)
            batch['dispatched_at'] = time.time()
            db.put('application_batch', batch)
            return {'ok': True}

    def claim(self, key, token, data):
        self.sweep()
        with self.service.store.transaction() as db:
            self.connector.authenticate(db, key, token)
            batch = self.service.entity(db, 'application_batch', data['batch_id'])
            require(batch['connection_id'] == key and batch['state'] in {'APPROVED', 'RUNNING'} and batch['expires_at'] > time.time(), '批次未确认、已暂停或已过期')
            self.current(db, batch)
            require(data['account_label'] == batch['account_label'], '当前显示账号与已确认账号不一致')
            running = [i for i in db.all('application_item') if i['batch_id'] == batch['id'] and i['state'] == 'RUNNING']
            require(not running, '上一项投递仍在处理，不能并行执行')
            item = next((i for i in db.all('application_item') if i['batch_id'] == batch['id'] and i['external_id'] == data['job']['external_id'] and i['state'] == 'PENDING'), None)
            require(item is not None, '岗位不在已确认的待投递范围内')
            opportunity = self.service.entity(db, 'opportunity', item['opportunity_id'])
            require(opportunity['content_hash'] == item['content_hash'] == canonical(data['job']), '岗位正文或筛选依据已变化，请重新核对批次')
            item.update(state='RUNNING', lease=secrets.token_urlsafe(24), lease_until=time.time() + 120, started_at=time.time(), baseline_ids=[])
            db.put('application_item', item)
            batch['state'] = 'RUNNING'
            db.put('application_batch', batch)
            return {'action': {**item, 'account_label': batch['account_label'], 'expires_at': item['lease_until']}}

    def action_in(self, db, key, token, action_id, lease):
        self.connector.authenticate(db, key, token)
        item = self.service.entity(db, 'application_item', action_id)
        require(item['connection_id'] == key and secrets.compare_digest(item.get('lease', ''), lease), '动作凭证不匹配', 403)
        return item

    def preflight(self, key, token, action_id, data):
        self.sweep()
        with self.service.store.transaction() as db:
            item = self.action_in(db, key, token, action_id, data['lease'])
            batch = self.service.entity(db, 'application_batch', item['batch_id'])
            require(item['state'] == 'RUNNING' and item['lease_until'] > time.time() and batch['state'] == 'RUNNING', '动作已停止或过期')
            self.current(db, batch)
            require(data['target_verified'] and data['account_label'] == batch['account_label'], '当前账号或目标岗位未核对')
            if data['stage'] == 'send_resume':
                require(item['mode'] == 'resume' and data['resume_label'] == item['resume_label'], '当前简历名称与批次确认内容不一致')
            if data['stage'] == 'send_greeting':
                require(item['mode'] == 'greeting', '该批次未授权发送招呼消息')
            item.update(stage=data['stage'], baseline_ids=data['message_ids'], preflight_at=time.time())
            db.put('application_item', item)
            return {'allowed': True}

    def result(self, key, token, action_id, data):
        with self.service.store.transaction() as db:
            item = self.action_in(db, key, token, action_id, data['lease'])
            require(item['state'] in {'RUNNING', 'UNKNOWN'}, '动作已结束，不能重复写入结果')
            outcome, evidence = data['outcome'], data['evidence']
            if outcome in {'COMMUNICATING', 'RESUME_SENT', 'RESUME_REQUESTED'}:
                require(item.get('preflight_at'), '动作未经过发送前核对', 422)
                require(data['receipt_key'] and data['receipt_key'] not in item.get('baseline_ids', []), '没有可核对的新平台回执，不能记为成功', 422)
                if outcome == 'COMMUNICATING':
                    require(item.get('stage') == 'send_greeting' and item['message'] in evidence, '新消息与已确认招呼内容不一致', 422)
                if outcome == 'RESUME_SENT':
                    require(item['mode'] == 'resume' and item.get('stage') == 'send_resume' and delivered(evidence, item['resume_label']), '未发现指定简历已发送的明确平台证据', 422)
                if outcome == 'RESUME_REQUESTED':
                    require(item['mode'] == 'resume' and item.get('stage') == 'send_resume' and '简历' in evidence and re.search(r'请求|申请|对方同意', evidence), '未发现简历请求的明确回执', 422)
            item.update(state=outcome, receipt_key=data['receipt_key'], evidence=redact(evidence), reason=data['reason'], finished_at=time.time())
            db.put('application_item', item)
            job = db.get('job', item['job_id'])
            if job and job['status'] in {'saved', 'applied', 'communicating'} and outcome in {'COMMUNICATING', 'RESUME_REQUESTED', 'RESUME_SENT', 'ALREADY_CONTACTED'}:
                new_status = 'applied' if outcome == 'RESUME_SENT' else 'communicating'
                # A communication receipt cannot regress an already delivered resume.
                if job['status'] != 'applied' or new_status == 'applied':
                    if job['status'] != new_status:
                        job['history'].append({'status': new_status, 'at': time.time(), 'source': 'boss-receipt'})
                    job.update(status=new_status, application_outcome=outcome, platform_evidence=redact(evidence)[:1000], platform_updated_at=time.time())
                    db.put('job', job)
            batch = self.service.entity(db, 'application_batch', item['batch_id'])
            remaining = [i for i in db.all('application_item') if i['batch_id'] == batch['id'] and i['state'] == 'PENDING']
            if batch['state'] in {'CANCELLED', 'NEEDS_REVIEW', 'EXPIRED'}:
                pass
            elif outcome in {'UNKNOWN', 'NEEDS_USER', 'FAILED'}:
                batch['state'] = 'NEEDS_REVIEW'
            elif not remaining:
                batch['state'] = 'DONE'
            db.put('application_batch', batch)
            return {'ok': True, 'batch_state': batch['state']}


    def receipts(self, key, token):
        with self.service.store.transaction() as db:
            self.connector.authenticate(db, key, token)
            values = []
            for item in db.all('application_item')[-200:]:
                if item['connection_id'] != key or item['state'] not in {'UNKNOWN', 'RESUME_REQUESTED'} or item.get('stage') not in {'open_chat', 'send_greeting', 'send_resume'}:
                    continue
                batch = db.get('application_batch', item['batch_id'])
                if batch:
                    values.append({**{k: item[k] for k in ('id', 'external_id', 'title', 'company', 'mode', 'resume_label', 'message', 'stage')}, 'baseline_ids': item.get('baseline_ids', []) + ([item['receipt_key']] if item.get('receipt_key') else []), 'account_label': batch['account_label']})
            return {'items': values}

    def synchronize(self, key, token, action_id, data):
        """Later platform receipts can advance a request; this endpoint cannot send."""
        with self.service.store.transaction() as db:
            self.connector.authenticate(db, key, token)
            item = self.service.entity(db, 'application_item', action_id)
            batch = self.service.entity(db, 'application_batch', item['batch_id'])
            require(item['connection_id'] == key and data['target_verified'] and data['account_label'] == batch['account_label'], '当前账号或目标不符', 403)
            require(item['state'] in {'UNKNOWN', 'COMMUNICATING', 'RESUME_REQUESTED'}, '当前状态无需重复同步')
            require(item.get('preflight_at') and data['receipt_key'] not in item.get('baseline_ids', []), '缺少可核验的新回执', 422)
            outcome, evidence = data['outcome'], data['evidence']
            if outcome == 'ALREADY_CONTACTED':
                require(item.get('stage') == 'open_chat' and len(evidence.strip()) >= 4, '只能用已核对的真实会话消息确认已有沟通', 422)
            elif outcome == 'COMMUNICATING':
                require(item['mode'] == 'greeting' and item.get('stage') == 'send_greeting' and item['message'] in evidence, '招呼回执不一致', 422)
            else:
                require(item['mode'] == 'resume' and item.get('stage') == 'send_resume', '本次未核对指定简历发送动作', 422)
                if outcome == 'RESUME_SENT':
                    require(delivered(evidence, item['resume_label']), '没有指定简历已发送的明确证据', 422)
                else:
                    require(re.search(r'请求|申请|对方同意', evidence) and '简历' in evidence, '没有简历请求回执', 422)
            item.update(state=outcome, receipt_key=data['receipt_key'], evidence=redact(evidence), reason='', platform_updated_at=time.time())
            db.put('application_item', item)
            job = db.get('job', item['job_id'])
            if job and job['status'] in {'saved', 'communicating', 'applied'}:
                status = 'applied' if outcome == 'RESUME_SENT' else 'communicating'
                if job['status'] != 'applied' or status == 'applied':
                    if job['status'] != status:
                        job['history'].append({'status': status, 'at': time.time(), 'source': 'boss-receipt'})
                    job.update(status=status, application_outcome=outcome, platform_evidence=redact(evidence)[:1000], platform_updated_at=time.time())
                    db.put('job', job)
            return {'ok': True, 'outcome': outcome}


def mount_applications(app, service, connector, opportunities, admin):
    applications = Applications(service, connector, opportunities)
    app.state.applications = applications
    token = lambda request: request.headers.get('authorization', '').removeprefix('Bearer ')

    @app.put('/api/boss/connections/{key}/auto-greeting', dependencies=[Depends(admin)])
    def greeting_rule(key: str, data: GreetingRule):
        return applications.set_greeting_rule(key, data.account_label)

    @app.get('/api/applications', dependencies=[Depends(admin)])
    def summary():
        return applications.summary()

    @app.post('/api/applications', dependencies=[Depends(admin)])
    def create(data: BatchInput):
        return applications.create(data.model_dump())

    @app.post('/api/applications/{key}/approve', dependencies=[Depends(admin)])
    def approve(key: str, data: ApprovalInput):
        return applications.approve(key, data.model_dump())

    @app.post('/api/applications/{key}/cancel', dependencies=[Depends(admin)])
    def cancel(key: str):
        return applications.cancel(key)

    @app.post('/api/connector/{key}/applications/drafts')
    def prepare_automatic(key: str, data: AutomaticDraftInput, request: Request):
        return applications.prepare_automatic(key, token(request), data)

    @app.get('/api/connector/{key}/applications')
    def ready(key: str, request: Request):
        return applications.ready(key, token(request))

    @app.post('/api/connector/{key}/applications/{batch_id}/dispatch')
    def dispatch(key: str, batch_id: str, request: Request):
        return applications.dispatch(key, token(request), batch_id)

    @app.post('/api/connector/{key}/applications/claim')
    def claim(key: str, data: ApplicationClaim, request: Request):
        return applications.claim(key, token(request), data.model_dump())

    @app.post('/api/connector/{key}/applications/{action_id}/preflight')
    def preflight(key: str, action_id: str, data: PreflightInput, request: Request):
        return applications.preflight(key, token(request), action_id, data.model_dump())

    @app.get('/api/connector/{key}/applications/receipts')
    def receipts(key: str, request: Request):
        return applications.receipts(key, token(request))

    @app.post('/api/connector/{key}/applications/{action_id}/sync')
    def synchronize(key: str, action_id: str, data: ReceiptSync, request: Request):
        return applications.synchronize(key, token(request), action_id, data.model_dump())

    @app.post('/api/connector/{key}/applications/{action_id}/result')
    def result(key: str, action_id: str, data: ApplicationResult, request: Request):
        return applications.result(key, token(request), action_id, data.model_dump())

    @app.post('/api/connector/{key}/applications/{batch_id}/cancel')
    def cancel_paired(key: str, batch_id: str, request: Request):
        with service.store.transaction() as db:
            connector.authenticate(db, key, token(request))
            batch = service.entity(db, 'application_batch', batch_id)
            require(batch['connection_id'] == key, '批次不属于此连接', 403)
        return applications.cancel(batch_id)

    return applications
