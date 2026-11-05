"""FastAPI 入口：恢复 → 迁移/结构自检 → 薄路由 → 静态托管 → 维护线程。"""
import logging
import secrets
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

import config
import logsetup
import schema
import watchdog
from db import engine
from routers import (admin, auth, docs, files, notifications, projects, search,
                     trash, users, ws)
from security.sessions import SESSION_COOKIE
from services import backup

BASE_DIR = Path(__file__).resolve().parent
WEB_DIR = BASE_DIR.parent / "web"
if not WEB_DIR.is_dir():
    raise RuntimeError(f"前端目录不存在:{WEB_DIR} —— 请先构建 lite/web/ 静态页")
logger = logging.getLogger("teamdoc.access")

logsetup.setup()
backup.apply_pending_restore()
schema.init(engine)


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    watchdog.start()
    yield


app = FastAPI(title="TeamDoc Lite", lifespan=_lifespan)


@app.exception_handler(HTTPException)
async def _http_error_handler(request: Request, exc: HTTPException):
    resp = JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})
    for k, v in (exc.headers or {}).items():
        resp.headers[k] = v
    if exc.status_code == 401:
        resp.delete_cookie(SESSION_COOKIE, path="/")
    return resp


@app.exception_handler(RequestValidationError)
async def _validation_handler(request: Request, exc: RequestValidationError):
    return JSONResponse(status_code=400,
                        content={"detail": {"code": "VALIDATION", "message": "参数校验失败"}})


app.include_router(auth.router)
app.include_router(users.router)
app.include_router(projects.router)
app.include_router(docs.router)
app.include_router(files.router)
app.include_router(notifications.router)
app.include_router(trash.router)
app.include_router(search.router)
app.include_router(admin.router)
app.include_router(ws.router)


@app.middleware("http")
async def _request_context(request: Request, call_next):
    request_id = secrets.token_hex(8)
    request.state.request_id = request_id
    resp = await call_next(request)
    resp.headers["X-Request-ID"] = request_id
    if request.url.path.startswith(("/css/", "/js/", "/vendor/")) \
            or request.url.path in ("/", "/index.html"):
        resp.headers["Cache-Control"] = "no-cache"
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
    resp.headers.setdefault("Referrer-Policy", "same-origin")
    logger.info("%s %s -> %s request_id=%s", request.method, request.url.path,
                resp.status_code, request_id)
    return resp


app.mount("/", StaticFiles(directory=str(WEB_DIR), html=True), name="web")
backup.start_scheduler()
PORT = config.PORT

if __name__ == "__main__":
    _config = uvicorn.Config(app, host="0.0.0.0", port=PORT, workers=1)
    logsetup.setup()
    uvicorn.Server(_config).run()
