"""文档与文件夹共用的树、排序和位置工具。"""
from sqlalchemy import func


def build_tree(rows, node_fn) -> list:
    nodes = {r.id: node_fn(r) for r in rows}
    roots = []
    for r in rows:
        node = nodes[r.id]
        parent = nodes.get(r.parent_id) if r.parent_id else None
        (parent["children"] if parent else roots).append(node)
    return roots


def collect_subtree(db, model, root) -> list:
    """返回 root 与全部后代 id，不看删除状态。"""
    rows = db.query(model.id, model.parent_id).filter_by(project_id=root.project_id).all()
    children: dict = {}
    for nid, pid in rows:
        children.setdefault(pid, []).append(nid)
    result, stack = [], [root.id]
    while stack:
        cur = stack.pop()
        result.append(cur)
        stack.extend(children.get(cur, []))
    return result


def next_sort(db, model, project_id, parent_id) -> float:
    q = (db.query(func.max(model.sort))
         .filter(model.project_id == project_id, model.deleted_at.is_(None))
         .filter(model.parent_id.is_(None) if parent_id is None
                 else model.parent_id == parent_id))
    return (q.scalar() or 0) + 1


def ancestor_names(db, model, start_id, attr: str) -> list[str]:
    names: list[str] = []
    cur_id, depth = start_id, 0
    while cur_id and depth < 64:
        node = db.get(model, cur_id)
        if not node:
            break
        names.insert(0, getattr(node, attr))
        cur_id = node.parent_id
        depth += 1
    return names


def location_json(db, project_id, model, start_id, attr: str) -> dict:
    from models import Project

    proj = db.get(Project, project_id)
    return {"projectId": project_id,
            "projectName": proj.name if proj else "",
            "path": ancestor_names(db, model, start_id, attr)}
