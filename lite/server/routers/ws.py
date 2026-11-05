"""实时协同 WebSocket(构建文档 §8)。

端点 /ws/docs/{doc_id};Cookie 认证;LWW(后写者赢)+ **基线校验** + 编辑保护提示。

基线校验(见 services.docs.save_doc_content):保存消息必须带 baseVersion,与服务端当前版本
不一致就回 conflict 给发送者本人 —— 不写库、不回 saved、也不向其他人广播。LWW 本身
保留("谁最后保存谁的内容在库里"),但它不再是一条静默路径:被覆盖的一方当场被告知,
由人决定是采纳远端还是保留自己这份。

**所有数据库操作都在 worker 线程里做**(run_in_threadpool)。本模块的处理器是
async、跑在事件循环上,而 SQLAlchemy 是同步的:直接在这里查库,一旦数据库卡顿
(等写锁、等磁盘 I/O),冻结的是**整个进程** —— HTTP、WebSocket、静态页一起无响应,
控制台却没有任何输出。放进线程池后,一次慢查询只影响自己这条连接。

数据库函数一律自建短会话、用完即关,并且**每条消息都重新复核权限**:WS 是长连接,
REST 的每请求校验覆盖不到它 —— 连接建立后管理员可能禁用该用户、把他移出项目或降为
VIEWER,不复查的话他仍能通过已开的连接持续写入文档。
"""
import json
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from starlette.concurrency import run_in_threadpool

from ids import IdPath
from security.sessions import SESSION_COOKIE
from services.docs import (ContentConflict, WsRejected, presence_users, str_content,
                           ws_handshake, ws_save)

logger = logging.getLogger("teamdoc.ws")

router = APIRouter()

# doc_id -> [{ws, userId, name, avatarColor, editing, readonly}]
POOL: dict[str, list[dict]] = {}


async def _broadcast(doc_id: str, message: dict, exclude: dict | None = None):
    conns = POOL.get(doc_id, [])
    dead = []
    for conn in conns:
        if exclude is not None and conn is exclude:
            continue
        try:
            await conn["ws"].send_json(message)
        except Exception:
            dead.append(conn)
    for conn in dead:
        if conn in conns:
            conns.remove(conn)


async def _broadcast_presence(doc_id: str):
    await _broadcast(doc_id, {"type": "presence", "users": presence_users(POOL.get(doc_id, []))})


@router.websocket("/ws/docs/{doc_id}")
async def doc_ws(websocket: WebSocket, doc_id: IdPath):
    await websocket.accept()
    conn = None
    try:
        token = websocket.cookies.get(SESSION_COOKIE)
        try:
            info = await run_in_threadpool(ws_handshake, token, doc_id)
        except WsRejected as exc:
            await websocket.close(code=exc.code)
            return
        conn = {"ws": websocket, **info}
        POOL.setdefault(doc_id, []).append(conn)
        logger.info("WS 建立 doc=%s user=%s", doc_id, conn["userId"])
        # 连接一注册服务端就推 presence:客户端据此判断"这条连接真的被接纳了"
        # (被鉴权/权限拒绝的连接收不到它,前端因此不会无脑重连)
        await _broadcast_presence(doc_id)

        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except (ValueError, TypeError):
                continue
            mtype = msg.get("type")
            if mtype == "presence":
                conn["editing"] = bool(msg.get("editing"))
                await _broadcast_presence(doc_id)
            elif mtype == "content":
                if conn["readonly"]:
                    continue  # readonly 连接直接忽略(§8)
                content = str_content(msg)
                if content is None:
                    continue
                # baseVersion 缺失/非法一律不写:不接受"没声明基线"的整篇覆盖。
                # 该保存明确失败(用户刷新页面即可),而不是无声地盖掉别人刚写的内容
                base_version = msg.get("baseVersion")
                if isinstance(base_version, bool) or not isinstance(base_version, int):
                    logger.warning("WS 非法保存消息(缺 baseVersion) doc=%s user=%s",
                                   doc_id, conn["userId"])
                    continue
                try:
                    saved = await run_in_threadpool(
                        ws_save, token, doc_id, content, base_version)
                except ContentConflict as c:
                    # 只回发送者:其他人根本没被改动,收到 conflict 只会莫名其妙。
                    # 用 continue 而不是关闭连接 —— 冲突是可恢复的正常状态
                    logger.info("WS 冲突 doc=%s user=%s base=%s current=%s",
                                doc_id, conn["userId"], base_version, c.version)
                    # 冲突现场与 REST 409 detail 同形(currentVersion/currentContent/by):
                    # "服务端冲突现场"是一个契约,两个传输层共用同一形状,前端无需归一
                    await websocket.send_json({"type": "conflict", "currentVersion": c.version,
                                               "currentContent": c.content, "by": c.by_name})
                    continue
                except WsRejected as exc:
                    logger.info("WS 关闭 doc=%s user=%s code=%s",
                                doc_id, conn["userId"], exc.code)
                    await websocket.close(code=exc.code)
                    return
                version, changed, by_name = (saved["version"], saved["changed"],
                                             saved["byName"])
                await websocket.send_json({"type": "saved", "version": version})
                if changed:
                    await _broadcast(doc_id, {"type": "remote", "content": content,
                                              "version": version, "by": by_name},
                                     exclude=conn)
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        # 一行一条(不展开栈):重连风暴时栈会把日志刷爆,而异常类型本身就是
        # "服务端是否在批量踢连接"的关键线索
        logger.warning("WS 异常 doc=%s user=%s: %s: %s", doc_id,
                       conn["userId"] if conn else None, type(exc).__name__, exc)
        try:
            await websocket.close(code=1011)
        except Exception:
            pass
    finally:
        if conn is not None:
            conns = POOL.get(doc_id, [])
            if conn in conns:
                conns.remove(conn)
            if not conns:
                POOL.pop(doc_id, None)
            else:
                await _broadcast_presence(doc_id)
            logger.info("WS 断开 doc=%s user=%s", doc_id, conn["userId"])
