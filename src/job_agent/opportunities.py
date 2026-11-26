"""Visible-page opportunity screening, separate from the user's saved opportunities."""
import hashlib
import json
import re
import time
import uuid
from pathlib import Path
from typing import List, Optional
from urllib.parse import urlencode, urlsplit

from fastapi import Depends, Request
from pydantic import BaseModel, Field

from .model import INTENT_VERSION, ModelOutputError
from .privacy import redact
from .service import require


class SearchPreferences(BaseModel):
    titles: List[str] = Field(default_factory=list, max_length=10)
    cities: List[str] = Field(default_factory=list, max_length=10)
    districts: List[str] = Field(default_factory=list, max_length=20)
    min_salary_k: Optional[float] = Field(default=None, ge=0, le=500)
    accept_internship: bool = False
    accept_other_cities: bool = False
    excluded_companies: List[str] = Field(default_factory=list, max_length=30)
    required_keywords: List[str] = Field(default_factory=list, max_length=15)
    require_all_keywords: bool = False
    min_score: int = Field(default=60, ge=0, le=100)
    min_coverage: float = Field(default=.35, ge=0, le=1)
    limit: int = Field(default=10, ge=1, le=20)
    search_limit: int = Field(default=5, ge=1, le=20)
    auto_favorite: bool = True


class DiscoveredJob(BaseModel):
    external_id: str = Field(min_length=1, max_length=200)
    title: str = Field(min_length=2, max_length=80)
    company: str = Field(min_length=1, max_length=100)
    city: str = Field(default="", max_length=80)
    url: str = Field(max_length=2000)
    description: str = Field(default="", max_length=20000)
    salary_text: str = Field(default="", max_length=100)
    salary_min_k: Optional[float] = Field(default=None, ge=0, le=500)
    salary_max_k: Optional[float] = Field(default=None, ge=0, le=500)


class CollectionInput(BaseModel):
    jobs: List[DiscoveredJob] = Field(min_length=1, max_length=20)
    search_url: str = Field(default='', max_length=2000)
    preferences_revision: Optional[int] = Field(default=None, ge=1)


BOSS_REGIONS = json.loads((Path(__file__).parent / 'static' / 'boss-regions.json').read_text(encoding='utf-8'))

def coverage_reason(report, minimum):
    rows = report['rows']
    if not rows:
        return 'AI 未提取到可评估的岗位要求，本次无法计算简历覆盖率'
    scored = sum(row.get('score') is not None for row in rows)
    reason = f"{len(rows)} 项岗位要求中，{scored} 项有可评分的简历原文，证据覆盖率为 {report['coverage']:.0%}"
    if minimum is not None and report['coverage'] < minimum:
        reason += f"，低于本次设置的 {minimum:.0%}"
    return reason


def intent_criteria(prefs):
    areas, _ = search_regions(prefs)
    criteria = {'方向': [redact(t) for t in prefs['titles']]}
    if areas and (not prefs['accept_other_cities'] or any(areas.values())):
        criteria['工作地点'] = {'目标城市及区县': areas, '接受其他城市': prefs['accept_other_cities']}
    if not prefs['accept_internship']:
        criteria['岗位类型'] = '排除实习岗位，常规招聘可接受'
    if prefs['min_salary_k'] is not None:
        criteria['月薪下限'] = f"最低月薪至少 {prefs['min_salary_k']:g}K"
    if prefs['excluded_companies']:
        criteria['排除公司'] = {'避开以下公司': [redact(c) for c in prefs['excluded_companies']]}
    if prefs['required_keywords']:
        key = '必需关键词' if prefs.get('require_all_keywords') else '偏好关键词'
        criteria[key] = [redact(k) for k in prefs['required_keywords']]
    return criteria


def search_regions(prefs):
    """Resolve city-qualified districts before opening any platform search."""
    cities = {c.strip().removesuffix('市'): [] for c in prefs['cities']}
    warnings = [f'暂不支持城市「{c}」，请从工作城市列表选择' for c in cities if c not in BOSS_REGIONS]
    for value in prefs.get('districts', []):
        parent, sep, name = value.rpartition('·')
        matches = [c for c in cities if name.strip() in BOSS_REGIONS.get(c, {}).get('districts', {})
                   and (not sep or parent.strip().removesuffix('市') == c)]
        if len(matches) != 1:
            warnings.append(f'请核对工作区县「{value}」及所属城市，同名区县可填写“城市·区县”')
        elif name.strip() not in cities[matches[0]]:
            cities[matches[0]].append(name.strip())
    return cities, warnings


def search_plan(prefs):
    """Apply the saved city and district on the official search page."""
    if not prefs['revision']:
        return {'entries': [], 'total': 0, 'warnings': []}
    cities, warnings = search_regions(prefs)
    entries = []
    regions = [(c, d) for c, districts in cities.items() for d in districts or ['']] if not warnings else []
    if prefs['accept_other_cities'] and not warnings:
        regions.append(('全国', ''))
    for title in prefs['titles']:
        for city, district in regions:
            params = {'city': '100010000' if city == '全国' else BOSS_REGIONS[city]['code']}
            if district:
                params['multiBusinessDistrict'] = BOSS_REGIONS[city]['districts'][district]
            params['query'] = title
            url = 'https://www.zhipin.com/web/geek/jobs?' + urlencode(params)
            entries.append({'title': title, 'city': city, 'district': district, 'url': url})
    limit = prefs.get('search_limit', 5)
    return {'entries': entries[:limit], 'total': len(entries), 'warnings': list(dict.fromkeys(warnings)),
            'per_search_limit': prefs['limit'], 'preferences_revision': prefs['revision']}


def validate_search_url(value, source):
    if not value:
        return
    url = urlsplit(value)
    require(not url.username and not url.password and not url.fragment, '搜索来源链接无效', 422)
    if source == 'fixture':
        require(url.scheme == 'http' and url.hostname == '127.0.0.1' and url.port == 8766 and url.path == '/boss-fixture', '模拟岗位的搜索来源无效', 422)
    else:
        require(url.scheme == 'https' and url.netloc == 'www.zhipin.com' and url.path == '/web/geek/jobs', '搜索来源必须为BOSS官方岗位列表', 422)


def canonical(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def validate_source(job):
    url = urlsplit(job['url'])
    if url.scheme == 'https' and url.hostname == 'www.zhipin.com':
        match = re.fullmatch(r'/job_detail/([\w-]+)\.html', url.path)
        require(match and match.group(1) == job['external_id'], '岗位链接与稳定ID不一致', 422)
        return 'boss'
    require(url.scheme == 'http' and url.hostname == '127.0.0.1' and url.port == 8766 and url.path == '/boss-fixture', '只接受BOSS官方岗位详情或本机模拟页面', 422)
    return 'fixture'


class Opportunities:
    def __init__(self, service, connector):
        self.service, self.connector = service, connector

    def preferences(self, db):
        return {**SearchPreferences().model_dump(), **(db.get('meta', 'search-preferences') or {'id': 'search-preferences', 'revision': 0})}

    def save_preferences(self, data):
        for field in ('titles', 'cities', 'districts', 'excluded_companies', 'required_keywords'):
            require(all(1 <= len(v.strip()) <= 80 for v in data[field]), '筛选项每项应为1至80字', 422)
            data[field] = list(dict.fromkeys(v.strip() for v in data[field]))
        require(bool(data['titles']), '请填写至少一个目标岗位', 422)
        require(data['accept_other_cities'] or bool(data['cities']), '请填写意向城市，或明确允许异地岗位', 422)
        _, warnings = search_regions(data)
        require(not warnings, '。'.join(warnings), 422)
        with self.service.store.transaction() as db:
            old = self.preferences(db)
            value = {'id': 'search-preferences', **data, 'revision': old['revision'] + 1, 'updated_at': time.time()}
            db.put('meta', value)
            for batch in db.all('application_batch'):
                if batch['state'] in {'DRAFT', 'APPROVED', 'RUNNING'}:
                    batch['state'] = 'NEEDS_REVIEW'
                    db.put('application_batch', batch)
            return value

    def screen(self, job, profile, prefs):
        excluded, pending, reasons = [], [], []
        requirements, report = [], None
        intent = {}
        if not job['description'].strip():
            pending.append('缺少岗位正文，待补充后由 AI 识别')
        else:
            posting = {k: job.get(k) or '' for k in ('title', 'company', 'city', 'salary_text', 'description')}
            low = job.get('salary_min_k')
            if low is not None:
                posting['verified_monthly_minimum'] = f'{low:g}K'
            intent, mandatory_quotes = self.service.model.assess_intent(intent_criteria(prefs), posting)
            for key, finding in intent.items():
                detail = key + ' · ' + finding['reason']
                if finding['quote']:
                    detail += '（岗位原文：“' + finding['quote'] + '”）'
                if key == '偏好关键词' or finding['status'] == 'met':
                    reasons.append(detail)
                elif finding['status'] == 'unmet':
                    excluded.append(detail)
                else:
                    pending.append(detail)
        if not excluded and not pending:
            if not profile:
                pending.append('请先保存我的简历')
            else:
                try:
                    requirements, report = self.service.model.matching(
                        None, [{'id': 'my-resume', 'text': profile['text']}], description=job['description'],
                        mandatory_quotes=mandatory_quotes)
                except ModelOutputError as error:
                    pending.append(str(error))
        if report is not None:
            evaluated = {req['text'] for req in requirements}
            pending.extend('硬性资格尚未逐项核实：' + quote for quote in mandatory_quotes if quote not in evaluated)
            score, cutoff = report['score'], prefs['min_score']
            core_supported = False
            for req, row in zip(requirements, report['rows']):
                if req['priority'] == 'mandatory' and row['status'] != 'met':
                    message = '硬性资格 · ' + req['text'] + '：' + row['reason']
                    if row['status'] == 'unmet':
                        excluded.append(message)
                    else:
                        pending.append(message)
                if req['priority'] == 'core' and row['status'] in ('met', 'partial') and row['score'] is not None:
                    core_supported = True
            if score is None or report['coverage'] < prefs['min_coverage']:
                pending.append(coverage_reason(report, prefs['min_coverage']))
            elif score < max(0, cutoff - 15):
                excluded.append(f'简历参考分 {score}，低于待核对区间下限 {cutoff - 15}')
            elif score < cutoff:
                pending.append(f'简历参考分 {score}，处于门槛 {cutoff} 以下的核对区间')
            elif not core_supported:
                pending.append('已有证据尚未支持核心要求')
            else:
                reasons.append('简历证据达到你设置的分数和覆盖率')
        return {'result': 'excluded' if excluded else 'review' if pending else 'matched', 'reasons': reasons,
                'excluded_reasons': excluded, 'review_reasons': pending, 'requirements': requirements,
                'intent': intent, 'report': report}

    def favorite_in(self, db, value):
        existing = next((j for j in db.all('job') if j.get('source') == value['source'] and j.get('boss_external_id') == value['external_id']), None)
        if existing:
            if (existing.get('requirements_origin') in {'literal-jd-skills', 'model-jd'}
                    or (existing.get('requirements_need_review') and existing['description'] == value['description'])) and value['screening']['report']:
                existing.pop('auto_match_error', None)
                existing.update(requirements=value['screening']['requirements'], requirements_origin='model-jd',
                                description=value['description'], requirements_need_review=False,
                                report={**value['screening']['report'], 'resume_revision': value['resume_revision'],
                                        'created_at': time.time()})
                db.put('job', existing)
            value['favorite_id'] = existing['id']
            return existing
        report = value['screening']['report']
        if report:
            report = {**report, 'resume_revision': value['resume_revision'], 'created_at': time.time()}
        job = {k: value[k] for k in ('title', 'company', 'city', 'url', 'description', 'source', 'salary_text')}
        job.update(id=uuid.uuid4().hex, boss_external_id=value['external_id'], requirements=value['screening']['requirements'],
                   report=report, requirements_need_review=not bool(value['screening']['requirements']), requirements_origin='model-jd',
                   created_at=time.time(), status='saved', followup_date='', notes='', history=[{'status': 'saved', 'at': time.time()}])
        db.put('job', job)
        value['favorite_id'] = job['id']
        return job

    def collect(self, key, token, jobs, search_url='', preferences_revision=None):
        with self.service.store.transaction() as db:
            self.connector.authenticate(db, key, token)
            profile = db.get('profile', 'me')
            prefs = self.preferences(db)
        require(prefs['revision'] > 0, '请先在工作台保存岗位筛选条件')
        require(preferences_revision is None or preferences_revision == prefs['revision'], '筛选条件已更新，请重新启动搜索')
        sources = [validate_source(job) for job in jobs]
        for source in sources:
            validate_search_url(search_url, source)
        results = []
        for job, source in zip(jobs, sources):
            if job.get('salary_min_k') is not None and job.get('salary_max_k') is not None:
                require(job['salary_min_k'] <= job['salary_max_k'], '薪资范围无效', 422)
            try:
                screened = self.screen(job, profile, prefs)
            except ModelOutputError as error:
                screened = {'result': 'review', 'reasons': [], 'excluded_reasons': [],
                            'review_reasons': [str(error)], 'requirements': [], 'report': None}
            value = {**job, 'matching_version': INTENT_VERSION,
                     'id': canonical([source, job['external_id']]), 'source': source, 'connection_id': key,
                     'content_hash': canonical(job), 'resume_revision': profile['revision'] if profile else None,
                     'search_url': search_url,
                     'preferences_revision': prefs['revision'], 'screening': screened, 'captured_at': time.time()}
            with self.service.store.transaction() as db:
                self.connector.authenticate(db, key, token)
                current = db.get('profile', 'me')
                require((current['revision'] if current else None) == value['resume_revision'] and self.preferences(db)['revision'] == prefs['revision'], '简历或筛选条件已更新，请重新筛选')
                old = db.get('opportunity', value['id'])
                if old and old.get('favorite_id') and db.get('job', old['favorite_id']):
                    value['favorite_id'] = old['favorite_id']
                if screened['result'] == 'matched' and prefs['auto_favorite']:
                    self.favorite_in(db, value)
                db.put('opportunity', value)
            results.append(value)
        return {'opportunities': results}

    def favorite(self, key):
        with self.service.store.transaction() as db:
            value = self.service.entity(db, 'opportunity', key)
            job = self.favorite_in(db, value)
            db.put('opportunity', value)
            return job

    def summary(self):
        with self.service.store.transaction() as db:
            profile = db.get('profile', 'me')
            prefs = self.preferences(db)
            values = db.all('opportunity')[::-1]
            for value in values:
                value['stale'] = value.get('matching_version') != INTENT_VERSION or bool(value.get('jd_outdated')) or value['resume_revision'] != (profile['revision'] if profile else None) or value['preferences_revision'] != prefs['revision']
                screen = value['screening']
                if screen.get('report', {}) and 'rows' in screen['report']:
                    minimum = prefs['min_coverage'] if value['preferences_revision'] == prefs['revision'] else None
                    screen['review_reasons'] = [
                        coverage_reason(screen['report'], minimum) if reason in
                        {'AI 匹配缺少可核对的简历证据', 'API 匹配缺少可核对的简历证据'} else reason
                        for reason in screen['review_reasons']]
            return {'preferences': prefs, 'search_plan': search_plan(prefs), 'opportunities': values, 'has_resume': bool(profile),
                    'demo_resume': bool(profile and (profile.get('is_demo') or profile.get('name') == '演示求职者'))}


def mount_opportunities(app, service, connector, admin):
    opportunities = Opportunities(service, connector)
    app.state.opportunities = opportunities

    @app.get('/api/opportunities', dependencies=[Depends(admin)])
    def summary():
        return opportunities.summary()

    @app.put('/api/opportunities/preferences', dependencies=[Depends(admin)])
    def preferences(data: SearchPreferences):
        prefs = opportunities.save_preferences(data.model_dump())
        return {**prefs, 'search_plan': search_plan(prefs)}

    @app.post('/api/opportunities/{key}/favorite', dependencies=[Depends(admin)])
    def favorite(key: str):
        return opportunities.favorite(key)

    @app.get('/api/connector/{key}/search')
    def search_settings(key: str, request: Request):
        with service.store.transaction() as db:
            connection = connector.authenticate(db, key, request.headers.get('authorization', '').removeprefix('Bearer '))
            prefs = opportunities.preferences(db)
            profile = db.get('profile', 'me')
            return {'preferences': prefs, 'search_plan': search_plan(prefs),
                    'auto_greeting_account': connection.get('auto_greeting_account', ''),
                    'resume_revision': profile['revision'] if profile else None,
                    'model_enabled': service.model.enabled, 'matching_version': INTENT_VERSION}

    @app.post('/api/connector/{key}/opportunities')
    def collect(key: str, data: CollectionInput, request: Request):
        return opportunities.collect(key, request.headers.get('authorization', '').removeprefix('Bearer '),
                                     [j.model_dump() for j in data.jobs], data.search_url, data.preferences_revision)

    return opportunities
