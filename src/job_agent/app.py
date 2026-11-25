import os
import re
import secrets
from datetime import date
from pathlib import Path
from typing import List, Literal

from fastapi import Depends, FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from pydantic import BaseModel, Field, field_validator

from .documents import extract_file
from .connector import mount_connector
from .opportunities import mount_opportunities
from .applications import mount_applications
from .service import Service, require


class ProfileInput(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    target: str = Field(default="", max_length=100)
    city: str = Field(default="", max_length=80)
    text: str = Field(min_length=20, max_length=50000)


class Requirement(BaseModel):
    id: str = Field(min_length=1, max_length=40)
    text: str = Field(min_length=2, max_length=160)
    keywords: List[str] = Field(min_length=1, max_length=10)
    weight: int = Field(default=3, ge=1, le=5)

    @field_validator("keywords")
    @classmethod
    def valid_keywords(cls, values):
        require(all(1 <= len(v.strip()) <= 50 for v in values), "每个关键词应为1至50字", 422)
        return [v.strip() for v in values]


class JobInput(BaseModel):
    title: str = Field(min_length=2, max_length=80)
    company: str = Field(min_length=1, max_length=100)
    city: str = Field(default="", max_length=80)
    url: str = Field(default="", max_length=2000)
    description: str = Field(default="", max_length=20000)
    requirements: List[Requirement] = Field(min_length=1, max_length=8)

    @field_validator("url")
    @classmethod
    def valid_url(cls, value):
        from urllib.parse import urlsplit
        if value:
            parsed = urlsplit(value)
            require(parsed.scheme in {"http", "https"} and bool(parsed.hostname) and not parsed.username, "岗位链接应为完整的HTTP或HTTPS网址", 422)
        return value


class TrackingInput(BaseModel):
    status: Literal["saved", "applied", "communicating", "interview", "offer", "closed"]
    followup_date: str = Field(default="", max_length=10)
    notes: str = Field(default="", max_length=5000)

    @field_validator("followup_date")
    @classmethod
    def valid_date(cls, value):
        if value:
            date.fromisoformat(value)
        return value


class FileInput(BaseModel):
    name: str = Field(max_length=160)
    content: str = Field(max_length=14000000)


class RequirementsInput(BaseModel):
    requirements: List[Requirement] = Field(min_length=1, max_length=8)


def create_app(directory=None, testing=False):
    service = Service(directory or os.getenv("JOB_AGENT_DATA", "data"))
    app = FastAPI(title="求职 Agent · 个人求职工作台", docs_url=None, redoc_url=None, openapi_url=None)
    app.state.service = service
    static = Path(__file__).parent / "static"

    @app.middleware("http")
    async def perimeter(request: Request, call_next):
        hosts = {"127.0.0.1", "localhost"} | ({"testserver"} if testing else set())
        if request.headers.get("host", "").split(":")[0] not in hosts:
            return JSONResponse({"detail": "仅允许本机访问"}, 403)
        origin = request.headers.get("origin", "")
        extension = bool(re.fullmatch(r"chrome-extension://[a-p]{32}", origin))
        allowed_origin = origin in {"http://127.0.0.1:8766", "http://localhost:8766"} or extension
        if origin and not allowed_origin:
            return JSONResponse({"detail": "请求来源未授权"}, 403)
        if extension and not request.url.path.startswith("/api/connector/"):
            return JSONResponse({"detail": "扩展只能访问配对连接接口"}, 403)
        if int(request.headers.get("content-length", "0") or 0) > 15 * 1024 * 1024:
            return JSONResponse({"detail": "请求内容过大"}, 413)
        response = Response(status_code=204) if request.method == "OPTIONS" else await call_next(request)
        if origin and allowed_origin:
            response.headers.update({"Access-Control-Allow-Origin": origin, "Access-Control-Allow-Headers": "Authorization,Content-Type",
                                     "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Vary": "Origin"})
        response.headers.update({"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY",
                                 "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'"})
        return response

    @app.exception_handler(RequestValidationError)
    async def validation(request, error):
        return JSONResponse({"detail": "请检查输入内容、长度和格式", "fields": [".".join(map(str, e["loc"])) for e in error.errors()]}, 422)

    def admin(request: Request):
        token = request.headers.get("authorization", "").removeprefix("Bearer ")
        require(secrets.compare_digest(token, service.admin_token), "工作台认证失败，请刷新本地页面", 401)

    connector = mount_connector(app, service, admin)
    opportunities = mount_opportunities(app, service, connector, admin)
    mount_applications(app, service, connector, opportunities, admin)

    @app.get("/", response_class=HTMLResponse)
    def index():
        return (static / "index.html").read_text().replace("__LOCAL_TOKEN__", service.admin_token)

    @app.get("/static/{name}")
    def asset(name: str):
        require(name in {"app.js", "style.css", "boss.js", "boss.css", "boss-adapter.js", "pipeline-adapter.js", "pipeline-fixture.js", "boss-fixture.js", "fixture-profile.json", "opportunities.js", "opportunities.css"}, "文件不存在", 404)
        media = "text/css" if name.endswith("css") else "application/json" if name.endswith("json") else "application/javascript"
        return Response((static / name).read_text(), media_type=media)

    @app.get("/health")
    def health():
        return {"status": "ok", "app": "job-search-agent", "scope": "local-single-user"}

    @app.get("/boss-fixture", response_class=HTMLResponse)
    def boss_fixture():
        return (static / "boss-fixture.html").read_text()

    @app.get("/downloads/job-agent-extension.zip")
    def extension_download():
        archive = Path(__file__).resolve().parents[2] / "artifacts/job-agent-extension.zip"
        require(archive.exists(), "请先运行 python3 scripts/package_extension.py", 404)
        return FileResponse(archive, filename="job-agent-extension.zip", media_type="application/zip")

    @app.get("/api/overview", dependencies=[Depends(admin)])
    def overview():
        return service.overview()

    @app.put("/api/profile", dependencies=[Depends(admin)])
    def profile(data: ProfileInput):
        return service.save_profile(data.model_dump())

    @app.delete("/api/profile", dependencies=[Depends(admin)])
    def delete_profile():
        service.delete_profile()
        return {"ok": True}

    @app.post("/api/files/extract", dependencies=[Depends(admin)])
    def file_extract(data: FileInput):
        return extract_file(data)

    @app.post("/api/jobs", dependencies=[Depends(admin)])
    def save_job(data: JobInput):
        return service.save_job(data.model_dump())

    @app.put("/api/jobs/{key}/requirements", dependencies=[Depends(admin)])
    def review_requirements(key: str, data: RequirementsInput):
        require(len({r.id for r in data.requirements}) == len(data.requirements), "要求ID不能重复", 422)
        with service.store.transaction() as db:
            record = service.entity(db, "job", key)
            require(record.get("requirements_need_review"), "此岗位要求已确认；调整时请重新收藏")
            record.update(requirements=[r.model_dump() for r in data.requirements], requirements_need_review=False, report=None)
            return db.put("job", record)

    @app.post("/api/jobs/{key}/assess", dependencies=[Depends(admin)])
    def assess(key: str):
        return service.assess(key)

    @app.put("/api/jobs/{key}/tracking", dependencies=[Depends(admin)])
    def track(key: str, data: TrackingInput):
        return service.track(key, data.model_dump())

    @app.get("/api/jobs/{key}/preparation", dependencies=[Depends(admin)])
    def prepare(key: str):
        return service.prepare(key)

    @app.delete("/api/jobs/{key}", dependencies=[Depends(admin)])
    def delete_job(key: str):
        service.delete_job(key)
        return {"ok": True}

    @app.post("/api/demo", dependencies=[Depends(admin)])
    def demo():
        return service.demo()

    return app


app = create_app()
