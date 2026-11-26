"""Follow up on replies to verified application conversations."""
import base64
import hashlib
import hmac
import re
import secrets
import socket
import ssl
import time
import uuid
from typing import List, Literal
from urllib.request import getproxies, proxy_bypass

import httpx
from fastapi import Depends, Request
from pydantic import BaseModel, Field

from .applications import delivered
from .privacy import redact
from .service import require


DEFAULT_REPLY = "您好，感谢您的回复！很高兴有机会进一步了解这个岗位。"
HOOK = re.compile(r"https://open\.feishu\.cn/open-apis/bot/v2/hook/[a-zA-Z0-9-]{16,100}")
CONTACTED = {"COMMUNICATING", "ALREADY_CONTACTED", "RESUME_SENT", "RESUME_REQUESTED"}


class Rule(BaseModel):
    enabled: bool
    account_label: str = Field(max_length=160)
    message: str = Field(max_length=2000)
    resume_label: str = Field(max_length=160)
    webhook: str = Field(default="", max_length=300)
    secret: str = Field(default="", max_length=200)
    confirmation: Literal["personal", "automatic"] = "personal"
    later_message: str = Field(default="", max_length=2000)


class Receipt(BaseModel):
    id: str = Field(min_length=1, max_length=200)
    role: Literal["me", "recruiter"]
    text: str = Field(default="", max_length=300)


class Scan(BaseModel):
    item_id: str
    revision: str
    account_label: str
    contact: str = Field(min_length=1, max_length=200)
    messages: List[Receipt] = Field(min_length=1, max_length=500)
    resume_seen: bool = False
    delivered_id: str = Field(default="", max_length=200)
    delivered_evidence: str = Field(default="", max_length=6000)


class Progress(BaseModel):
    item_id: str
    lease: str
    stage: Literal["reply", "resume"]
    outcome: Literal["check", "sent", "requested", "review"]
    evidence: str = Field(default="", max_length=6000)
    receipt_key: str = Field(default="", max_length=200)
    reason: str = Field(default="", max_length=500)
    personal_confirmation: bool = False
    baseline_ids: List[str] = Field(default_factory=list, max_length=500)


def settings(db, key):
    rule = db.get("follow_rule", key) or dict(id=key, enabled=False, account_label="", message=DEFAULT_REPLY,
                                               resume_label="", webhook="", secret="", revision="")
    rule.setdefault("confirmation", "automatic" if rule["enabled"] and rule["resume_label"] else "personal")
    return rule


def public(rule):
    return {**{k: rule[k] for k in ("enabled", "account_label", "message", "resume_label", "confirmation")},
            "later_message": rule.get("later_message", "" if rule["enabled"] else "收到，谢谢您！我会仔细看一下您的消息。"),
            "webhook_configured": bool(rule["webhook"]), "signed": bool(rule["secret"])}


def eligible(db, key, rule, item):
    if not item or item["connection_id"] != key or item["state"] not in CONTACTED:
        return False
    batch = db.get("application_batch", item["batch_id"])
    job = db.get("job", item["job_id"])
    return bool(rule["enabled"] and batch and batch["account_label"] == rule["account_label"] and job
                and job["status"] in {"communicating", "applied", "interview", "offer"})


def mark_applied(db, job_id):
    job = db.get("job", job_id)
    if job and job["status"] == "communicating":
        job["status"] = "applied"
        job["history"].append({"status": "applied", "at": time.time(), "source": "boss-followup"})
        db.put("job", job)


def follow_delivery(evidence, label):
    if label:
        return delivered(evidence, label)
    if re.fullmatch(r"附件卡片：[^/\\<>\r\n]{1,156}\.(?:pdf|docx?)", evidence, re.I):
        return True
    return bool(re.fullmatch(r"(?:您|你|我)?(?:已成功发送|已发送)(?:了)?(?:一份)?(?:附件)?简历(?:给(?:对方|招聘方|HR|Boss))?[。！!]?", evidence.strip(), re.I))


def collect(db, key, rule, data):
    item = db.get("application_item", data.item_id)
    require(eligible(db, key, rule, item) and data.revision == rule["revision"]
            and data.account_label == rule["account_label"], "跟进设置或岗位已变化")
    ids = [m.id for m in data.messages]
    require(len(ids) == len(set(ids)), "消息编号重复，请检查页面", 422)
    watch = db.get("follow_watch", item["id"]) or {
        "id": item["id"], "job_id": item["job_id"], "connection_id": key, "reply": "", "resume": ""}
    if (watch["resume"] in {"requested", "review", "sending", "awaiting_confirmation"} and watch.get("file_baseline") is not None
            and watch.get("contact") == data.contact
            and data.delivered_id and data.delivered_id not in watch["file_baseline"]
            and follow_delivery(data.delivered_evidence, watch.get("filename", ""))):
        watch.update(resume="sent", reason="")
        mark_applied(db, item["job_id"])
        db.put("follow_watch", watch)
    # A new rule establishes a new baseline, while prior send reservations survive edits and restarts.
    same_session = watch.get("revision") == rule["revision"]
    if same_session:
        require(watch["contact"] == data.contact, "招聘方身份有变化，请核对会话")
        anchor = watch["cursor"]
    else:
        anchor = item.get("receipt_key") if item.get("finished_at", 0) >= rule["since"] else None
        if anchor and anchor not in ids:
            return {"status": "请在 BOSS 加载原招呼回执，以核对后续新消息"}
        watch.update(revision=rule["revision"], contact=data.contact)
    if same_session and anchor not in ids:
        return {"status": "未找到上次消息，请在 BOSS 加载相邻聊天记录后继续"}
    fresh = data.messages[ids.index(anchor)+1:] if anchor in ids else []
    watch["cursor"] = ids[-1]
    if data.resume_seen or item["state"] in {"RESUME_SENT", "RESUME_REQUESTED"}:
        watch["resume"] = watch["resume"] or "existing"
    incoming = [m for m in fresh if m.role == "recruiter"]
    action = None
    if incoming:
        event_id = hashlib.sha256((item["id"] + "/" + incoming[-1].id).encode()).hexdigest()
        if not db.get("follow_notice", event_id):
            db.put("follow_notice", dict(id=event_id, connection_id=key, job_id=item["job_id"], at=time.time(),
                                         status="queued", revision=rule["revision"], count=len(incoming),
                                         company=item["company"], title=item["title"], preview=redact(incoming[-1].text)[:300]))
            # If the candidate already answered, leave the conversation to them.
            first = not watch["reply"]
            finished = watch["reply"] == "manual" or (watch["reply"] == "sent" and watch["resume"] in {"sent", "requested", "existing", "review", "manual", "awaiting_confirmation"})
            message = rule["message"] if first else rule.get("later_message", "")
            if message and (first or finished) and data.messages[-1].role == "recruiter" and any(m.role == "me" for m in data.messages):
                watch.update(reply="reserved", filename=watch.get("filename", rule["resume_label"]), reply_text=message, lease=secrets.token_urlsafe(24), expires_at=time.time()+90)
                action = dict(id=item["id"], account_label=data.account_label, title=item["title"], company=item["company"],
                              contact=data.contact, trigger=ids[-1], expires_at=watch["expires_at"], lease=watch["lease"],
                              message=message, resume_label=rule["resume_label"], direct_resume=not rule["resume_label"], confirmation=rule["confirmation"], send_resume=first and not watch["resume"])
            elif not watch["reply"] and data.messages[-1].role == "me":
                watch["reply"] = "manual"
                watch["resume"] = watch["resume"] or "manual"
    db.put("follow_watch", watch)
    return {"action": action, "status": "已检查新回复" if same_session or fresh else "已记录当前会话基线"}


def send_notice(rule, message):
    payload = {"msg_type": "text", "content": {"text": message}}
    if rule["secret"]:
        stamp = str(int(time.time()))
        signature = hmac.new((stamp + "\n" + rule["secret"]).encode(), digestmod=hashlib.sha256).digest()
        payload.update(timestamp=stamp, sign=base64.b64encode(signature).decode())
    try:
        # Resolve only the HTTPS destination, as curl does. An unrelated ALL_PROXY
        # (e.g. SOCKS) must not prevent initialization of a working HTTPS proxy.
        proxies = getproxies()
        proxy = None if proxy_bypass("open.feishu.cn") else proxies.get("https") or proxies.get("all")
        with httpx.Client(proxy=proxy, trust_env=bool(proxy), timeout=8, follow_redirects=False) as client:
            response = client.post(rule["webhook"], json=payload)
    except httpx.TimeoutException:
        return "unknown", "等待飞书响应超时，请先查看群内是否已收到提醒"
    except httpx.ProxyError:
        return "unknown", "工作台连接代理失败，请检查启动工作台时使用的代理设置"
    except httpx.ConnectError as exc:
        cause = exc
        while cause:
            if isinstance(cause, socket.gaierror):
                return "unknown", "工作台无法解析飞书或代理的域名，请检查工作台运行环境的 DNS 和代理设置"
            if isinstance(cause, ssl.SSLError):
                return "unknown", "工作台与飞书建立 TLS 连接失败，请检查证书和系统时间"
            cause = cause.__cause__ or cause.__context__
        return "unknown", "工作台无法连接飞书，请检查工作台运行环境的网络和代理设置"
    except (httpx.HTTPError, ValueError, ImportError, OSError):
        return "unknown", "工作台未能完成飞书请求，请检查启动环境的代理和证书配置"

    try:
        body = response.json()
    except ValueError:
        body = None
    code = body.get("code", body.get("StatusCode")) if isinstance(body, dict) else None
    if response.is_success and type(code) is int and code == 0:
        return "sent", ""
    hints = {
        19021: "签名校验未通过，请核对机器人签名密钥与 Mac 系统时间",
        19022: "当前出口 IP 不在机器人的 IP 白名单内",
        19024: "消息没有命中机器人的关键词，请将“求职提醒”加入允许的关键词",
    }
    if type(code) is int and code != 0:
        return "failed", f"飞书错误码 {code} · " + hints.get(code, "请核对目标群的机器人设置")
    if not response.is_success:
        return "failed", f"Webhook 请求返回 HTTP {response.status_code}，请核对完整机器人地址和网络配置"
    return "unknown", "收到的响应缺少飞书机器人回执，请先查看目标群是否收到提醒"


def deliver_next(service):
    with service.store.transaction() as db:
        event = next((e for e in db.all("follow_notice") if e["status"] == "queued"), None)
        if not event:
            return False
        rule = settings(db, event["connection_id"])
        connection = db.get("boss_connection", event["connection_id"])
        active = connection and not connection["revoked"] and rule["enabled"] and rule["revision"] == event["revision"]
        event["status"] = "sending" if active else "cancelled"
        db.put("follow_notice", event)
    if active:
        outcome, detail = send_notice(rule, f"求职提醒｜{event['company']} · {event['title']}\nHR 有 {event['count']} 条新回复，请打开 BOSS 直聘查看。")
        with service.store.transaction() as db:
            if db.get("follow_notice", event["id"]):
                event.update(status=outcome, detail=detail)
                db.put("follow_notice", event)
    return True


def notify_worker(service):
    while not service.match_stop.is_set():
        if not deliver_next(service):
            service.match_stop.wait(2)


def mount_followups(app, service, connector, admin):
    store = service.store
    with store.transaction() as db:
        for watch in db.all("follow_watch"):
            for stage in ("reply", "resume"):
                if watch[stage] in {"reserved", "sending"}:
                    watch.update({stage: "review", "reason": "上次执行中断，请在 BOSS 核对"})
                    db.put("follow_watch", watch)
        for event in db.all("follow_notice"):
            if event["status"] == "sending":
                event["status"] = "unknown"
                db.put("follow_notice", event)

    def auth(db, key, request):
        connector.authenticate(db, key, request.headers.get("authorization", "").removeprefix("Bearer "))

    @app.get("/api/boss/connections/{key}/followup", dependencies=[Depends(admin)])
    def read(key: str):
        with store.transaction() as db:
            rule = settings(db, key)
            events = []
            for e in reversed(db.all("follow_notice")):
                if e["connection_id"] == key:
                    events.append({k: e.get(k, "") for k in ("company", "title", "status", "at", "count", "detail", "preview")})
                    if len(events) == 10:
                        break
            return {**public(rule), "events": events,
                    "actions": [{k: w.get(k, "") for k in ("job_id", "reply", "resume", "reason")}
                                for w in reversed(db.all("follow_watch")) if w["connection_id"] == key and w["reply"]][:20]}

    @app.put("/api/boss/connections/{key}/followup", dependencies=[Depends(admin)])
    def save(key: str, data: Rule):
        with store.transaction() as db:
            require(not service.entity(db, "boss_connection", key)["revoked"], "连接已撤销")
            old = settings(db, key)
            hook = data.webhook.strip() or old["webhook"]
            require(not hook or HOOK.fullmatch(hook), "请输入飞书自定义机器人的完整 Webhook", 422)
            rule = dict(id=key, enabled=data.enabled, account_label=data.account_label.strip(), message=data.message.strip(),
                        confirmation=data.confirmation, later_message=data.later_message.strip(), resume_label=data.resume_label.strip(), webhook=hook, secret=data.secret.strip() or (old["secret"] if hook == old["webhook"] else ""),
                        since=time.time(), revision=uuid.uuid4().hex)
            require(not data.enabled or all(rule[k] for k in ("account_label", "message", "webhook")),
                    "开启前请填写账号、首次回复文字和飞书 Webhook", 422)
            if any(rule[k] != old.get(k, "") for k in ("confirmation", "enabled", "account_label", "message", "later_message", "resume_label", "webhook", "secret")):
                db.put("follow_rule", rule)
            return public(rule)

    @app.post("/api/boss/connections/{key}/followup/test", dependencies=[Depends(admin)])
    def test_notice(key: str):
        with store.transaction() as db:
            rule = settings(db, key)
            require(bool(rule["webhook"]), "请先保存飞书机器人地址")
        outcome, detail = send_notice(rule, "求职提醒｜飞书机器人连接测试")
        require(outcome == "sent", detail, 502)
        return {"ok": True}

    @app.get("/api/connector/{key}/followup")
    def targets(key: str, request: Request):
        with store.transaction() as db:
            auth(db, key, request)
            rule = settings(db, key)
            return {"revision": rule["revision"], "account_label": rule["account_label"], "enabled": rule["enabled"],
                    "items": [{**{k: i[k] for k in ("id", "title", "company", "source")},
                               "resume_label": (db.get("follow_watch", i["id"]) or {}).get("filename", rule["resume_label"])}
                              for i in db.all("application_item")
                              if eligible(db, key, rule, i)] if rule["enabled"] else []}

    @app.post("/api/connector/{key}/followup/scan")
    def scan(key: str, data: Scan, request: Request):
        with store.transaction() as db:
            auth(db, key, request)
            return collect(db, key, settings(db, key), data)

    @app.post("/api/connector/{key}/followup/progress")
    def progress(key: str, data: Progress, request: Request):
        with store.transaction() as db:
            auth(db, key, request)
            item = service.entity(db, "application_item", data.item_id)
            watch = service.entity(db, "follow_watch", item["id"])
            rule = settings(db, key)
            require(item["connection_id"] == key and secrets.compare_digest(watch.get("lease", ""), data.lease)
                    and bool(data.lease), "跟进凭证无效", 403)
            stage = data.stage
            if data.outcome == "check":
                require(eligible(db, key, rule, item) and watch["revision"] == rule["revision"]
                        and time.time() < watch["expires_at"], "跟进已暂停或过期")
                require((stage == "reply" and watch["reply"] == "reserved") or
                        (stage == "resume" and watch["reply"] == "sent" and not watch["resume"]), "该步骤已处理")
                if stage == "resume" and rule["confirmation"] == "personal":
                    require(data.personal_confirmation, "请重新加载扩展以启用本人确认发送")
                watch[stage] = "sending"
                if stage == "resume":
                    watch["file_baseline"] = data.baseline_ids
                    if rule["confirmation"] == "personal":
                        watch[stage] = "awaiting_confirmation"
            else:
                require(watch[stage] == "sending" or (data.outcome == "review" and watch[stage] in {"", "reserved", "awaiting_confirmation"}), "该步骤已结束")
                if data.outcome != "review":
                    require(data.receipt_key and (stage != "resume" or data.receipt_key not in watch.get("file_baseline", [])) and ((stage == "reply" and data.outcome == "sent" and watch["reply_text"] in data.evidence)
                            or (stage == "resume" and ((data.outcome == "sent" and follow_delivery(data.evidence, watch["filename"]))
                            or (data.outcome == "requested" and "简历" in data.evidence and re.search(r"请求|申请|对方同意", data.evidence))))),
                            "回执与跟进内容不符")
                watch[stage] = data.outcome
                watch["reason"] = data.reason
                if stage == "resume" and data.outcome == "sent":
                    mark_applied(db, item["job_id"])
            db.put("follow_watch", watch)
            return {"ok": True}
