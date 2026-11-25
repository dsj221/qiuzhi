"""Visible-page opportunity screening, separate from the user's saved opportunities."""
import hashlib
import json
import re
import time
import uuid
from typing import List, Optional
from urllib.parse import urlencode, urlsplit

from fastapi import Depends, Request
from pydantic import BaseModel, Field

from .service import require


class SearchPreferences(BaseModel):
    titles: List[str] = Field(default_factory=list, max_length=10)
    cities: List[str] = Field(default_factory=list, max_length=10)
    min_salary_k: Optional[float] = Field(default=None, ge=0, le=500)
    accept_internship: bool = False
    accept_other_cities: bool = False
    excluded_companies: List[str] = Field(default_factory=list, max_length=30)
    required_keywords: List[str] = Field(default_factory=list, max_length=15)
    min_score: int = Field(default=50, ge=0, le=100)
    min_coverage: float = Field(default=.5, ge=0, le=1)
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


BOSS_CITIES = {'上海': '101020100', '杭州': '101210100', '合肥': '101220100',
               '北京': '101010100', '广州': '101280100', '深圳': '101280600', '成都': '101270100'}


def search_plan(prefs):
    """Search broadly on the official page; exact requirements remain local screening rules."""
    if not prefs['revision']:
        return {'entries': [], 'total': 0, 'warnings': []}
    cities = ['全国'] if prefs['accept_other_cities'] else prefs['cities']
    entries, warnings, seen = [], [], set()
    for title in prefs['titles']:
        for city in cities:
            code = BOSS_CITIES.get(city.removesuffix('市'))
            if city != '全国' and not code:
                warnings.append(city + '暂未配置平台城市代码，将全国搜索后按意向城市严格筛选')
            url = 'https://www.zhipin.com/web/geek/jobs?' + urlencode({'query': title, 'city': code or '100010000'})
            if url in seen:
                continue
            seen.add(url)
            entries.append({'title': title, 'city': city if code else '全国', 'url': url})
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


SKILLS = [
    'Python', 'C++', 'Java', 'JavaScript', 'TypeScript', 'Golang', 'SQL', 'MySQL', 'PostgreSQL',
    'SQLite', 'Redis', 'FastAPI', 'Flask', 'Django', 'React', 'Vue', 'Node.js', 'Git', 'Docker',
    'Kubernetes', 'Linux', 'LangChain', 'LangGraph', 'RAG', 'Agent', 'Dify', 'LLM', 'PyTorch',
    'TensorFlow', '机器学习', '深度学习', '大模型', '数据分析', '自动化', '产品设计', '用户研究',
    'CAD', 'SolidWorks', 'CATIA', 'Creo', 'SLAM', '项目管理', '测试',
]


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


def requirements_from_jd(text):
    """Draft extraction of literal skills, not a claim of semantic JD understanding."""
    result = []
    for skill in SKILLS:
        pattern = r'(?<![A-Za-z0-9])' + re.escape(skill) + r'(?![A-Za-z0-9])' if skill.isascii() else re.escape(skill)
        if re.search(pattern, text, re.I):
            result.append({'id': 'R' + str(len(result) + 1), 'text': '岗位原文提及 ' + skill, 'keywords': [skill], 'weight': 3})
            if len(result) == 8:
                break
    return result


class Opportunities:
    def __init__(self, service, connector):
        self.service, self.connector = service, connector

    def preferences(self, db):
        return {**SearchPreferences().model_dump(), **(db.get('meta', 'search-preferences') or {'id': 'search-preferences', 'revision': 0})}

    def save_preferences(self, data):
        for field in ('titles', 'cities', 'excluded_companies', 'required_keywords'):
            require(all(1 <= len(v.strip()) <= 80 for v in data[field]), '筛选项每项应为1至80字', 422)
            data[field] = list(dict.fromkeys(v.strip() for v in data[field]))
        require(bool(data['titles']), '请填写至少一个目标岗位', 422)
        require(data['accept_other_cities'] or bool(data['cities']), '请填写意向城市，或明确允许异地岗位', 422)
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
        haystack = job['title'] + '\n' + job['description']
        if not any(t.casefold() in job['title'].casefold() for t in prefs['titles']):
            excluded.append('岗位名称不符合目标方向')
        else:
            reasons.append('岗位名称符合目标方向')
        if not prefs['accept_other_cities']:
            if not job['city']:
                pending.append('工作城市尚未核验')
            elif not any(c.casefold() in job['city'].casefold() for c in prefs['cities']):
                excluded.append('不在意向城市范围')
            else:
                reasons.append('城市符合筛选条件')
        if not prefs['accept_internship'] and '实习' in haystack:
            excluded.append('已排除实习岗位')
        if any(c.casefold() in job['company'].casefold() for c in prefs['excluded_companies']):
            excluded.append('公司在排除清单中')
        if prefs['min_salary_k'] is not None:
            if job.get('salary_min_k') is None:
                pending.append('薪资未能可靠读取，需核验')
            elif job['salary_min_k'] < prefs['min_salary_k']:
                excluded.append('薪资区间下限低于要求')
            else:
                reasons.append('月薪区间下限达到要求')
        missing = [k for k in prefs['required_keywords'] if k.casefold() not in haystack.casefold()]
        if missing:
            excluded.append('岗位缺少必需关键词：' + '、'.join(missing))
        requirements = requirements_from_jd(job['description'])
        report = None
        if len(job['description'].strip()) < 20:
            pending.append('缺少完整岗位正文')
        elif not requirements:
            pending.append('未能从岗位正文提取可核对的技能，请人工查看')
        elif not profile:
            pending.append('请先保存我的简历')
        else:
            report = self.service.model.assess(requirements, [{'id': 'my-resume', 'text': profile['text']}])
            if report['score'] is None or report['coverage'] < prefs['min_coverage']:
                pending.append('简历证据覆盖不足，需人工核对')
            elif report['score'] < prefs['min_score']:
                excluded.append('参考分低于筛选阈值')
            else:
                reasons.append('简历证据达到所设匹配阈值')
        return {'result': 'excluded' if excluded else 'review' if pending else 'matched', 'reasons': reasons,
                'excluded_reasons': excluded, 'review_reasons': pending, 'requirements': requirements, 'report': report}

    def favorite_in(self, db, value):
        existing = next((j for j in db.all('job') if j.get('source') == value['source'] and j.get('boss_external_id') == value['external_id']), None)
        if existing:
            value['favorite_id'] = existing['id']
            return existing
        report = value['screening']['report']
        if report:
            report = {**report, 'resume_revision': value['resume_revision'], 'created_at': time.time()}
        job = {k: value[k] for k in ('title', 'company', 'city', 'url', 'description', 'source', 'salary_text')}
        job.update(id=uuid.uuid4().hex, boss_external_id=value['external_id'], requirements=value['screening']['requirements'],
                   report=report, requirements_need_review=not bool(value['screening']['requirements']), requirements_origin='literal-jd-skills',
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
            screened = self.screen(job, profile, prefs)
            value = {**job, 'id': canonical([source, job['external_id']]), 'source': source, 'connection_id': key,
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
                value['stale'] = bool(value.get('jd_outdated')) or value['resume_revision'] != (profile['revision'] if profile else None) or value['preferences_revision'] != prefs['revision']
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
            connector.authenticate(db, key, request.headers.get('authorization', '').removeprefix('Bearer '))
            prefs = opportunities.preferences(db)
            return {'preferences': prefs, 'search_plan': search_plan(prefs)}

    @app.post('/api/connector/{key}/opportunities')
    def collect(key: str, data: CollectionInput, request: Request):
        return opportunities.collect(key, request.headers.get('authorization', '').removeprefix('Bearer '),
                                     [j.model_dump() for j in data.jobs], data.search_url, data.preferences_revision)

    return opportunities
