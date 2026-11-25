"""Personal resume, job evidence, and application lifecycle."""
import secrets
import time
import uuid
from pathlib import Path

from fastapi import HTTPException

from .model import Model
from .privacy import redact
from .store import Store


def require(condition, message, code=409):
    if not condition:
        raise HTTPException(code, message)


class Service:
    def __init__(self, directory, model=None):
        directory = Path(directory)
        directory.mkdir(parents=True, exist_ok=True)
        directory.chmod(0o700)
        self.store = Store(directory / "job-agent.sqlite3")
        self.model = model or Model(directory)
        token = directory / "admin.token"
        if not token.exists():
            with token.open("x") as file:
                token.chmod(0o600)
                file.write(secrets.token_urlsafe(32))
        self.admin_token = token.read_text().strip()

    def entity(self, db, kind, key):
        value = db.get(kind, key)
        require(value is not None, "记录不存在", 404)
        return value

    def overview(self):
        with self.store.transaction() as db:
            return {"profile": db.get("profile", "me"), "jobs": db.all("job")[::-1],
                    "model_enabled": self.model.enabled, "model_name": self.model.name}

    def save_profile(self, data):
        text = redact(data["text"])
        require(len(text) >= 20, "脱敏后的简历正文至少需要20字", 422)
        with self.store.transaction() as db:
            old = db.get("profile", "me")
            profile = {"id": "me", "name": redact(data["name"]), "text": text,
                       "target": redact(data["target"]), "city": data["city"],
                       "revision": old["revision"] + 1 if old else 1, "updated_at": time.time(), "is_demo": False}
            db.put("profile", profile)
            # An old report must never look like a match for an edited resume.
            for job in db.all("job"):
                job["report"] = None
                db.put("job", job)
            for batch in db.all('application_batch'):
                if batch['state'] in {'DRAFT', 'APPROVED', 'RUNNING'}:
                    batch['state'] = 'NEEDS_REVIEW'
                    db.put('application_batch', batch)
            return profile

    def save_job(self, data):
        require(len({r["id"] for r in data["requirements"]}) == len(data["requirements"]), "要求ID不能重复", 422)
        with self.store.transaction() as db:
            return db.put("job", {**data, "id": uuid.uuid4().hex, "created_at": time.time(),
                                  "status": "saved", "followup_date": "", "notes": "", "report": None,
                                  "history": [{"status": "saved", "at": time.time()}]})

    def assess(self, key):
        with self.store.transaction() as db:
            job = self.entity(db, "job", key)
            require(not job.get("requirements_need_review"), "请先校对从 BOSS 导入的岗位要求和关键词")
            profile = db.get("profile", "me")
            require(profile is not None, "请先保存我的简历")
            requirements_snapshot, description_snapshot = job["requirements"], job.get("description", "")
        report = self.model.assess(job["requirements"], [{"id": "my-resume", "text": profile["text"]}])
        report.update(resume_revision=profile["revision"], created_at=time.time())
        with self.store.transaction() as db:
            current = db.get("profile", "me")
            require(current is not None and current["revision"] == profile["revision"], "简历已更新，请重新匹配")
            job = self.entity(db, "job", key)
            require(job["requirements"] == requirements_snapshot and job.get("description", "") == description_snapshot,
                    "岗位JD或要求已更新，请校对后重新匹配")
            job["report"] = report
            db.put("job", job)
        return report

    def track(self, key, data):
        with self.store.transaction() as db:
            job = self.entity(db, "job", key)
            if job["status"] != data["status"]:
                job["history"].append({"status": data["status"], "at": time.time()})
            job.update(data, updated_at=time.time())
            return db.put("job", job)

    def prepare(self, key):
        with self.store.transaction() as db:
            job = self.entity(db, "job", key)
            profile = db.get("profile", "me")
            require(profile is not None, "请先保存我的简历")
        require(job["report"] is not None, "请先完成岗位匹配，再生成准备清单")
        rows = {r["requirement_id"]: r for r in job["report"]["rows"]}
        questions = []
        for req in job["requirements"]:
            row = rows[req["id"]]
            evidence = row["evidence"]
            questions.append({"requirement": req["text"], "status": row["status"],
                              "question": "请围绕“" + req["text"] + "”介绍一个真实案例：目标、你的行动、结果，以及方案取舍。",
                              "evidence": evidence,
                              "tip": "从原文出发，补充个人职责与可核实结果。" if evidence else "简历尚未提供依据；如有相关经历可补充，没有则如实说明并准备学习计划。"})
        relevant = next((r["evidence"][0]["quote"] for r in rows.values() if r["evidence"] and r["status"] in {"met", "partial"}), None)
        greeting = "您好，我关注到贵公司的“" + job["title"] + "”岗位，希望进一步了解岗位职责与团队情况。"
        if relevant:
            greeting += "我的相关经历是：“" + relevant + "”。"
        greeting += "方便的话，我可以提供简历供您了解。"
        return {"greeting": greeting, "questions": questions,
                "ask_employer": ["这个岗位当前最希望解决的问题是什么？", "团队如何协作，如何评价这个岗位的工作成果？", "后续面试流程和预计时间安排是怎样的？"],
                "engine": "template", "notice": "依据岗位和简历生成的准备模板，请自行补充真实细节。沟通草稿需你确认后手动发送。"}

    def delete_job(self, key):
        with self.store.transaction() as db:
            self.entity(db, "job", key)
            for item in db.all('application_item'):
                if item['job_id'] == key and item['state'] in {'DRAFT', 'PENDING', 'RUNNING'}:
                    item['state'] = 'UNKNOWN' if item['state'] == 'RUNNING' else 'CANCELLED'
                    db.put('application_item', item)
                    batch = db.get('application_batch', item['batch_id'])
                    if batch:
                        batch['state'] = 'NEEDS_REVIEW'
                        db.put('application_batch', batch)
            for kind in ("boss_message", "boss_action", "boss_snapshot"):
                for record in db.all(kind):
                    if record["job_id"] == key:
                        db.delete(kind, record["id"])
            for connection in db.all("boss_connection"):
                if (connection.get("session") or {}).get("job_id") == key:
                    connection["session"] = None
                    db.put("boss_connection", connection)
            db.delete("job", key)
            for opportunity in db.all('opportunity'):
                if opportunity.get('favorite_id') == key:
                    opportunity.pop('favorite_id', None)
                    db.put('opportunity', opportunity)

    def delete_profile(self):
        with self.store.transaction() as db:
            db.delete("profile", "me")
            for batch in db.all('application_batch'):
                if batch['state'] in {'DRAFT', 'APPROVED', 'RUNNING'}:
                    batch['state'] = 'NEEDS_REVIEW'
                    db.put('application_batch', batch)
            for job in db.all("job"):
                job["report"] = None
                db.put("job", job)
            for opportunity in db.all('opportunity'):
                opportunity['screening']['report'] = None
                db.put('opportunity', opportunity)

    def demo(self):
        with self.store.transaction() as db:
            require(db.get("profile", "me") is None and not db.all("job"), "演示仅可载入空工作台，避免覆盖你的数据")
            db.put("profile", {"id": "me", "name": "演示求职者", "target": "Python 后端开发实习", "city": "上海",
                               "text": "项目经历：使用 Python 和 FastAPI 开发校园活动报名服务，负责接口设计、测试和部署。使用 SQLite 保存活动与报名记录，为项目编写了接口测试。参与社团网站协作，通过 Git 提交代码与评审。", "revision": 1, "updated_at": time.time(), "is_demo": True})
            db.put("job", {"id": uuid.uuid4().hex, "title": "Python 后端开发实习生（演示）", "company": "示例科技 · 虚构公司", "city": "上海", "url": "", "description": "参与后端接口开发，维护数据库，与团队共同交付项目。",
                           "requirements": [{"id": "R1", "text": "Python 服务开发", "keywords": ["Python", "FastAPI"], "weight": 5}, {"id": "R2", "text": "数据库使用", "keywords": ["SQL", "SQLite"], "weight": 3}, {"id": "R3", "text": "Docker 部署", "keywords": ["Docker"], "weight": 2}],
                           "created_at": time.time(), "status": "saved", "followup_date": "", "notes": "这是一条虚构演示岗位。", "report": None, "history": [{"status": "saved", "at": time.time()}]})
        return {"ok": True}
