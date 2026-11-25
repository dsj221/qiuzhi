"""Paired, DOM-only BOSS connector. Drafts are filled, never sent by this service."""
import hashlib
import json
import re
import secrets
import time
import uuid
from typing import List, Literal, Optional
from urllib.parse import urlsplit

from fastapi import Depends, Request
from pydantic import BaseModel, Field

from .privacy import redact
from .service import require


class ConnectionInput(BaseModel):
    label: str = Field(min_length=1, max_length=80)


class ViewLabels(BaseModel):
    account: str = Field(default="", max_length=160)
    conversation: str = Field(default="", max_length=160)
    position: str = Field(default="", max_length=160)


class PageJob(BaseModel):
    external_id: str = Field(min_length=1, max_length=200)
    title: str = Field(min_length=2, max_length=80)
    company: str = Field(min_length=1, max_length=100)
    city: str = Field(default="", max_length=80)
    description: str = Field(min_length=20, max_length=20000)
    url: str = Field(max_length=2000)
    confirmed: bool
    verified_chat: Optional[ViewLabels] = None


class ChatJobInput(BaseModel):
    title: str = Field(min_length=2, max_length=80)
    company: str = Field(min_length=1, max_length=100)
    position: str = Field(min_length=2, max_length=160)
    confirmed: bool


def jd_requirements(description):
    lines = [s.strip(" ·•-\t") for s in description.splitlines() if len(s.strip()) >= 4][:8]
    return [{"id": "R" + str(i+1), "text": line[:160], "keywords": [line[:50]], "weight": 3} for i, line in enumerate(lines)]


class Binding(BaseModel):
    account: str = Field(min_length=1, max_length=200)
    job: str = Field(min_length=1, max_length=200)
    conversation: str = Field(min_length=1, max_length=200)


class Message(BaseModel):
    event_key: str = Field(default="", max_length=200)
    role: Literal["me", "recruiter"]
    text: str = Field(min_length=1, max_length=6000)


class Observation(BaseModel):
    job_id: str
    binding: Binding
    messages: List[Message] = Field(max_length=200)
    baseline: bool = False
    confirmed: bool = False
    capture_mode: Literal["stable", "snapshot"] = "stable"
    labels: Optional[ViewLabels] = None


class DraftInput(BaseModel):
    text: str = Field(min_length=1, max_length=3000)


class Claim(BaseModel):
    job_id: str
    binding: Binding
    fingerprint: str = Field(min_length=64, max_length=64)
    manual_confirmed: bool = False


class FillResult(BaseModel):
    lease: str = Field(min_length=10, max_length=100)
    outcome: Literal["FILLED", "FAILED", "UNKNOWN"]


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def fingerprint(messages):
    return digest(json.dumps(messages, ensure_ascii=False, sort_keys=True, separators=(",", ":")))


class Connector:
    def __init__(self, service):
        self.service = service
        with service.store.transaction() as db:
            for action in db.all("boss_action"):
                if action["state"] == "FILLING":
                    action["state"] = "UNKNOWN"
                    db.put("boss_action", action)

    def entity(self, db, kind, key):
        return self.service.entity(db, kind, key)

    def authenticate(self, db, key, token):
        connection = self.entity(db, "boss_connection", key)
        require(not connection["revoked"] and secrets.compare_digest(connection["token_hash"], digest(token)), "配对已失效或凭证不正确", 401)
        return connection

    def summary(self):
        with self.service.store.transaction() as db:
            result = []
            for connection in db.all("boss_connection"):
                item = {k: v for k, v in connection.items() if k != "token_hash"}
                age = time.time() - (connection["last_seen"] or 0)
                item["status"] = "revoked" if connection["revoked"] else "syncing" if age < 15 and connection.get("session") else "paired" if age < 60 else "waiting"
                result.append(item)
            messages = db.all("boss_message")[-500:]
            for snapshot in db.all("boss_snapshot"):
                messages.extend({"id": snapshot["id"] + ":" + str(i), "connection_id": snapshot["id"],
                                 "job_id": snapshot["job_id"], "binding": snapshot["binding"], **m,
                                 "at": snapshot["at"], "baseline": False, "snapshot": True}
                                for i, m in enumerate(snapshot["messages"]))
            return {"connections": result, "job_ids": [j["id"] for j in db.all("job")], "messages": messages,
                    "actions": [{k: v for k, v in a.items() if k != "lease"} for a in db.all("boss_action")[-100:]]}

    def create(self, label):
        key, token = uuid.uuid4().hex, secrets.token_urlsafe(32)
        with self.service.store.transaction() as db:
            db.put("boss_connection", {"id": key, "label": label, "token_hash": digest(token), "revoked": False,
                                      "created_at": time.time(), "last_seen": None, "session": None})
        return {"base": "http://127.0.0.1:8766", "connection_id": key, "token": token}

    def invalidate(self, db, connection_id):
        for action in db.all("boss_action"):
            if action["connection_id"] == connection_id and action["state"] in {"DRAFT", "APPROVED", "FILLING"}:
                action["state"] = "UNKNOWN" if action["state"] == "FILLING" else "CANCELLED"
                db.put("boss_action", action)

    def revoke(self, key):
        with self.service.store.transaction() as db:
            connection = self.entity(db, "boss_connection", key)
            connection["revoked"] = True
            db.put("boss_connection", connection)
            self.invalidate(db, key)
            for batch in db.all('application_batch'):
                if batch['connection_id'] == key and batch['state'] in {'DRAFT', 'APPROVED', 'RUNNING'}:
                    batch['state'] = 'NEEDS_REVIEW'
                    db.put('application_batch', batch)

    def jobs(self, key, token):
        with self.service.store.transaction() as db:
            connection = self.authenticate(db, key, token)
            connection["last_seen"] = time.time()
            db.put("boss_connection", connection)
            return {"bound_job_id": (connection.get("session") or {}).get("job_id"), "labels": connection.get("labels"),
                    "jobs": [{**{k: j[k] for k in ("id", "title", "company")}, "url": j.get("url", ""),
                              "external_id": j.get("boss_external_id", ""),
                              "needs_jd": j.get("source") == "boss-chat" and not j.get("jd_fetched_at")}
                             for j in db.all("job")]}

    def update_jd(self, key, token, job_id, data):
        require(data["confirmed"], "请确认获取所选岗位的JD", 422)
        try:
            url = urlsplit(data["url"])
            port = url.port
        except ValueError:
            require(False, "岗位链接格式不正确", 422)
        match = re.fullmatch(r"/job_detail/([\w-]+)\.html", url.path)
        official = (url.scheme == "https" and url.hostname == "www.zhipin.com" and port in {None, 443}
                    and not url.username and not url.password and match and match.group(1) == data["external_id"])
        fixture = (url.scheme == "http" and url.hostname == "127.0.0.1" and port == 8766
                   and url.path == "/boss-fixture" and not url.username and not url.password)
        require(official or fixture, "岗位链接与ID不一致，或不是BOSS官方岗位详情", 422)
        normalize = lambda value: "".join(value.split()).casefold()
        description = data["description"].strip()
        require(len(description) >= 20, "岗位正文不足，请打开完整详情后重试", 422)
        with self.service.store.transaction() as db:
            connection = self.authenticate(db, key, token)
            job = self.entity(db, "job", job_id)
            require(job.get("source") in ({"fixture"} if fixture else {"boss", "boss-chat"}), "所选岗位与JD来源不一致")
            require(normalize(job["title"]) == normalize(data["title"]) and normalize(job["company"]) == normalize(data["company"]),
                    "获取的JD与所选岗位名称或公司不一致，未覆盖原档案")
            require(not job.get("boss_external_id") or job["boss_external_id"] == data["external_id"], "获取的JD属于其他岗位，未覆盖原档案")
            if data.get('verified_chat'):
                labels = data['verified_chat']
                require(official and job.get('source') == 'boss-chat' and
                        (connection.get('session') or {}).get('job_id') == job_id and
                        all((connection.get('labels') or {}).get(k) == redact(labels[k]) for k in ('account', 'conversation', 'position')),
                        '原会话绑定已变化，请重新核对')
                require(not any(j['id'] != job_id and j.get('source') == 'boss' and
                                j.get('boss_external_id') == data['external_id'] for j in db.all('job')),
                        '此岗位已有官方记录，请刷新后重试')
                job['source'] = 'boss'
            changed = job.get("description") != description
            if changed:
                job.update(description=description, requirements=jd_requirements(description), requirements_need_review=True, report=None)
                affected_opportunities = set()
                for opportunity in db.all("opportunity"):
                    same_posting = opportunity.get("source") == ("fixture" if fixture else "boss") and opportunity.get("external_id") == data["external_id"]
                    if opportunity.get("favorite_id") == job_id or same_posting:
                        opportunity["jd_outdated"] = True
                        db.put("opportunity", opportunity)
                        affected_opportunities.add(opportunity["id"])
                affected = {i["batch_id"] for i in db.all("application_item")
                            if i.get("job_id") == job_id or i.get("opportunity_id") in affected_opportunities}
                for batch in db.all("application_batch"):
                    if batch["id"] in affected and batch["state"] in {"DRAFT", "APPROVED", "RUNNING"}:
                        batch["state"] = "NEEDS_REVIEW"
                        db.put("application_batch", batch)
            job.update(url=url._replace(query="", fragment="").geturl(), boss_external_id=data["external_id"],
                       jd_fetched_at=time.time(), jd_source_url=data["url"])
            if data.get("city"):
                job["city"] = data["city"]
            db.put("job", job)
            connection["last_seen"] = time.time()
            db.put("boss_connection", connection)
            return {"job_id": job_id, "changed": changed, "requirements_need_review": job.get("requirements_need_review", False)}

    def import_job(self, key, token, data):
        require(data["confirmed"], "请先确认导入当前可见岗位", 422)
        url = urlsplit(data["url"])
        fixture = url.hostname == "127.0.0.1" and url.port == 8766 and url.path == "/boss-fixture"
        require((url.scheme == "https" and url.hostname == "www.zhipin.com") or (url.scheme == "http" and fixture), "只接受 BOSS 官方页面或本机模拟页面", 422)
        with self.service.store.transaction() as db:
            self.authenticate(db, key, token)
            old = next((j for j in db.all("job") if j.get("boss_external_id") == data["external_id"] and j.get("source") == ("fixture" if fixture else "boss")), None)
            if old:
                repaired = False
                normalize = lambda value: "".join(value.split())
                previous, company, city = normalize(old['company']), normalize(data['company']), normalize(data.get('city', ''))
                if city and previous.startswith(company) and re.fullmatch(re.escape(city) + r'(?:经验不限|在校/应届|\d+(?:-\d+)?年|\d+年以上)(?:本科|硕士|博士|大专|高中|中专|学历不限)', previous[len(company):]):
                    old['company'] = data['company']
                    db.put('job', old)
                    repaired = True
                return {"job_id": old["id"], "existing": True, "metadata_repaired": repaired}
            # Do not pretend that a scraped JD has been semantically decomposed.
            requirements = jd_requirements(data["description"])
            record = {k: data[k] for k in ("title", "company", "city", "description", "url")}
            record.update(id=uuid.uuid4().hex, requirements=requirements, created_at=time.time(), status="saved", followup_date="", notes="", report=None,
                          history=[{"status": "saved", "at": time.time()}], source="fixture" if fixture else "boss", boss_external_id=data["external_id"], requirements_need_review=True)
            db.put("job", record)
            return {"job_id": record["id"], "existing": False}

    def create_chat_job(self, key, token, data):
        require(data["confirmed"], "请核对当前聊天的岗位与公司后确认建立档案", 422)
        require(data["title"].casefold() in data["position"].casefold(), "岗位名称与当前会话显示不一致", 422)
        with self.service.store.transaction() as db:
            self.authenticate(db, key, token)
            record = {"id": uuid.uuid4().hex, "title": data["title"], "company": data["company"], "city": "", "url": "",
                      "description": "从本人确认的BOSS聊天岗位显示建立。完整JD尚未导入，请补充岗位要求后再进行匹配。", "requirements": [],
                      "created_at": time.time(), "status": "communicating", "followup_date": "", "notes": "聊天档案，JD待补充。", "report": None,
                      "history": [{"status": "communicating", "at": time.time()}], "source": "boss-chat", "requirements_need_review": True}
            db.put("job", record)
            return {"job_id": record["id"]}

    def observe(self, key, token, data):
        messages = data["messages"]
        mode = data.get("capture_mode", "stable")
        if mode == "stable":
            require(all(m["event_key"] for m in messages) and len({m["event_key"] for m in messages}) == len(messages), "消息缺少ID或ID重复，停止同步", 422)
        else:
            require(all(v.startswith("view:") for v in data["binding"].values()), "快照绑定必须是本次页面会话，不能冒充平台身份", 422)
        with self.service.store.transaction() as db:
            connection = self.authenticate(db, key, token)
            job = self.entity(db, "job", data["job_id"])
            if mode == "snapshot":
                position = (data.get("labels") or {}).get("position", "")
                require(job["title"].casefold() in position.casefold(), "所选内部岗位与当前聊天岗位不一致，请先创建或选择对应岗位")
            session = {"job_id": data["job_id"], "binding": data["binding"]}
            previous = connection.get("session")
            if data["baseline"]:
                require(data["confirmed"], "首次绑定必须确认当前账号、岗位与招聘方会话", 422)
                self.invalidate(db, key)
                if previous and mode == "stable" and connection.get("capture_mode", "stable") == "stable":
                    require(previous["binding"]["account"] == session["binding"]["account"], "账号已变化，请撤销并重新配对")
            else:
                require(previous == session, "账号、岗位或招聘方会话已变化，请停止并重新绑定")
                require(connection.get("capture_mode", "stable") == mode, "读取方式已变化，请重新绑定")
            clean = [{**m, "text": redact(m["text"])} for m in messages]
            # Hash the original observation, then retain only redacted messages. A change
            # to contact details must also invalidate drafts even if redaction is identical.
            current_fingerprint = fingerprint(messages)
            if connection.get("fingerprint") != current_fingerprint:
                self.invalidate(db, key)
            for message in clean if mode == "stable" else []:
                message_id = digest(key + json.dumps(data["binding"], sort_keys=True) + message["event_key"])
                old = db.get("boss_message", message_id)
                if old:
                    require(old["text"] == message["text"] and old["role"] == message["role"], "已同步消息的内容或方向发生变化，请核对后重新配对")
                else:
                    db.put("boss_message", {"id": message_id, "connection_id": key, "job_id": data["job_id"],
                                            "binding": data["binding"], **message, "at": time.time(), "baseline": data["baseline"]})
            if mode == "snapshot":
                db.put("boss_snapshot", {"id": key, **session, "messages": clean, "at": time.time()})
            else:
                db.delete("boss_snapshot", key)
            raw_labels = data.get("labels") or {}
            labels = {k: redact(str(raw_labels.get(k, "")))[:160] for k in ("account", "conversation", "position")}
            connection.update(session=session, last_seen=time.time(), fingerprint=current_fingerprint, capture_mode=mode, labels=labels)
            db.put("boss_connection", connection)
            return {"ok": True, "fingerprint": current_fingerprint, "count": len(clean)}

    def draft(self, key, text):
        with self.service.store.transaction() as db:
            connection = self.entity(db, "boss_connection", key)
            require(not connection["revoked"] and connection.get("session") and time.time() - (connection["last_seen"] or 0) < 15, "请先在扩展绑定当前会话并开启同步")
            require(not any(a["connection_id"] == key and a["state"] in {"FILLING", "UNKNOWN"} for a in db.all("boss_action")), "有待核对的填入结果，请先检查 BOSS 输入框")
            self.invalidate(db, key)
            value = {"id": uuid.uuid4().hex, "connection_id": key, **connection["session"], "text": text,
                     "fingerprint": connection["fingerprint"], "capture_mode": connection.get("capture_mode", "stable"),
                     "state": "DRAFT", "created_at": time.time()}
            return db.put("boss_action", value)

    def approve(self, key):
        with self.service.store.transaction() as db:
            action = self.entity(db, "boss_action", key)
            connection = self.entity(db, "boss_connection", action["connection_id"])
            require(action["state"] == "DRAFT" and not connection["revoked"], "草稿已失效，请重新保存")
            require(time.time() - (connection["last_seen"] or 0) < 15 and connection.get("session") == {"job_id": action["job_id"], "binding": action["binding"]} and connection["fingerprint"] == action["fingerprint"], "会话已变化或未同步，请重新保存草稿")
            action.update(state="APPROVED", approved_at=time.time())
            return db.put("boss_action", action)

    def claim(self, key, token, data):
        with self.service.store.transaction() as db:
            connection = self.authenticate(db, key, token)
            require(connection.get("session") == {"job_id": data["job_id"], "binding": data["binding"]}, "会话不匹配")
            require(connection.get("fingerprint") == data["fingerprint"] and time.time() - (connection["last_seen"] or 0) < 15, "页面已变化，请先同步")
            if connection.get("capture_mode") == "snapshot":
                require(data.get("manual_confirmed"), "快照模式需在扩展中核对当前会话并点击填入，不会自动领取草稿")
            for action in db.all("boss_action"):
                if action["connection_id"] != key or action["state"] != "APPROVED":
                    continue
                if time.time() - action["approved_at"] > 120:
                    action["state"] = "CANCELLED"
                    db.put("boss_action", action)
                    continue
                require(action["fingerprint"] == data["fingerprint"], "草稿对应的消息已变化")
                action.setdefault("capture_mode", "stable")
                action.update(state="FILLING", lease=secrets.token_urlsafe(24), claimed_at=time.time())
                db.put("boss_action", action)
                return {"action": {k: action[k] for k in ("id", "job_id", "binding", "text", "lease", "capture_mode")}}
            return {"action": None}

    def result(self, key, token, action_id, data):
        with self.service.store.transaction() as db:
            self.authenticate(db, key, token)
            action = self.entity(db, "boss_action", action_id)
            require(action["connection_id"] == key and secrets.compare_digest(action.get("lease", ""), data["lease"]), "动作凭证不匹配", 403)
            require(action["state"] in {"FILLING", "UNKNOWN"}, "动作已结束，不能重复回执")
            action.update(state=data["outcome"], resolved_at=time.time())
            db.put("boss_action", action)
            return {"ok": True}

    def resolve(self, key):
        with self.service.store.transaction() as db:
            action = self.entity(db, "boss_action", key)
            require(action["state"] in {"FILLING", "UNKNOWN", "FILLED"}, "此动作不需要核对")
            action.update(state="CHECKED", resolved_at=time.time())
            db.put("boss_action", action)
        return {"ok": True}


def mount_connector(app, service, admin):
    connector = Connector(service)
    app.state.connector = connector

    def token(request):
        return request.headers.get("authorization", "").removeprefix("Bearer ")

    @app.get("/api/boss", dependencies=[Depends(admin)])
    def summary():
        return connector.summary()

    @app.post("/api/boss/connections", dependencies=[Depends(admin)])
    def create(data: ConnectionInput):
        return connector.create(data.label)

    @app.delete("/api/boss/connections/{key}", dependencies=[Depends(admin)])
    def revoke(key: str):
        connector.revoke(key)
        return {"ok": True}

    @app.post("/api/boss/connections/{key}/drafts", dependencies=[Depends(admin)])
    def draft(key: str, data: DraftInput):
        return connector.draft(key, data.text)

    @app.post("/api/boss/actions/{key}/approve", dependencies=[Depends(admin)])
    def approve(key: str):
        action = connector.approve(key)
        return {k: v for k, v in action.items() if k != "lease"}

    @app.post("/api/boss/actions/{key}/resolve", dependencies=[Depends(admin)])
    def resolve(key: str):
        return connector.resolve(key)

    @app.get("/api/connector/{key}/jobs")
    def jobs(key: str, request: Request):
        return connector.jobs(key, token(request))

    @app.post("/api/connector/{key}/jobs")
    def import_job(key: str, data: PageJob, request: Request):
        return connector.import_job(key, token(request), data.model_dump())

    @app.post("/api/connector/{key}/chat-job")
    def create_chat_job(key: str, data: ChatJobInput, request: Request):
        return connector.create_chat_job(key, token(request), data.model_dump())

    @app.post("/api/connector/{key}/jobs/{job_id}/jd")
    def update_jd(key: str, job_id: str, data: PageJob, request: Request):
        return connector.update_jd(key, token(request), job_id, data.model_dump())

    @app.post("/api/connector/{key}/observations")
    def observe(key: str, data: Observation, request: Request):
        return connector.observe(key, token(request), data.model_dump())

    @app.post("/api/connector/{key}/claim")
    def claim(key: str, data: Claim, request: Request):
        return connector.claim(key, token(request), data.model_dump())

    @app.post("/api/connector/{key}/actions/{action_id}/result")
    def result(key: str, action_id: str, data: FillResult, request: Request):
        return connector.result(key, token(request), action_id, data.model_dump())

    return connector
