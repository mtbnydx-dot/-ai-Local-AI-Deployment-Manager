const OPENWEBUI_AUDIT_EXPORTER = String.raw`
import datetime
import hashlib
import json
import os
import pathlib
import sqlite3
import sys

DB = "/app/backend/data/webui.db"
OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/openwebui_audit_export"
os.makedirs(OUT, exist_ok=True)

def ts(value):
    if value is None:
        return None
    try:
        number = float(value)
        if number > 1e12:
            number = number / 1000
        return datetime.datetime.fromtimestamp(number, datetime.timezone.utc).isoformat()
    except Exception:
        return str(value)

def load_json(value, fallback):
    if value is None:
        return fallback
    if isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(value)
    except Exception:
        return fallback

def file_hash(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()

def extract_messages(chat_obj):
    messages = []
    seen = set()
    if not isinstance(chat_obj, dict):
        return messages
    root_messages = chat_obj.get("messages")
    if isinstance(root_messages, list):
        for index, msg in enumerate(root_messages):
            if isinstance(msg, dict):
                seen.add(id(msg))
                messages.append((str(msg.get("id") or index), msg))
    history = chat_obj.get("history") or {}
    hist_messages = history.get("messages") if isinstance(history, dict) else None
    if isinstance(hist_messages, dict):
        for key, msg in hist_messages.items():
            if isinstance(msg, dict) and id(msg) not in seen:
                messages.append((str(key), msg))
    elif isinstance(hist_messages, list):
        for index, msg in enumerate(hist_messages):
            if isinstance(msg, dict) and id(msg) not in seen:
                messages.append((f"history-{index}", msg))
    return messages

con = sqlite3.connect(DB)
con.row_factory = sqlite3.Row
rows = con.execute("""
    select c.id, c.user_id, c.title, c.share_id, c.archived, c.created_at, c.updated_at,
           c.chat, c.pinned, c.meta, c.folder_id, c.tasks, c.summary, c.last_read_at,
           u.name as user_name, u.email as user_email, u.role as user_role
    from chat c
    left join user u on u.id = c.user_id
    order by c.updated_at desc
""").fetchall()

users = [dict(row) for row in con.execute("select id, name, email, role, created_at, updated_at, last_active_at from user order by created_at")]
export = {
    "exported_at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "source": DB,
    "format": "openwebui-full-audit-v1",
    "chat_count": len(rows),
    "message_count": 0,
    "users": users,
    "chats": [],
}

markdown = [
    "# Open WebUI Full Conversation Audit Export",
    "",
    f"- Exported UTC: {export['exported_at_utc']}",
    f"- Chat count: {len(rows)}",
    "",
]

for row in rows:
    chat_obj = load_json(row["chat"], {})
    meta = load_json(row["meta"], {})
    tasks = load_json(row["tasks"], None)
    messages = []
    for msg_id, msg in extract_messages(chat_obj):
        content = msg.get("content")
        item = {
            "id": msg.get("id") or msg_id,
            "parent_id": msg.get("parentId") or msg.get("parent_id"),
            "role": msg.get("role"),
            "model": msg.get("model"),
            "timestamp": ts(msg.get("timestamp") or msg.get("created_at")),
            "content": content,
            "content_sha256": hashlib.sha256(str(content or "").encode("utf-8")).hexdigest(),
            "metadata": {k: v for k, v in msg.items() if k not in {"content"}},
        }
        messages.append(item)
    export["message_count"] += len(messages)
    chat_record = {
        "id": row["id"],
        "user_id": row["user_id"],
        "user_name": row["user_name"],
        "user_email": row["user_email"],
        "user_role": row["user_role"],
        "title": row["title"],
        "share_id": row["share_id"],
        "archived": bool(row["archived"]),
        "pinned": bool(row["pinned"]) if row["pinned"] is not None else False,
        "folder_id": row["folder_id"],
        "created_at": ts(row["created_at"]),
        "updated_at": ts(row["updated_at"]),
        "last_read_at": ts(row["last_read_at"]),
        "summary": row["summary"],
        "meta": meta,
        "tasks": tasks,
        "models": chat_obj.get("models") if isinstance(chat_obj, dict) else [],
        "params": chat_obj.get("params") if isinstance(chat_obj, dict) else {},
        "raw_chat": chat_obj,
        "message_count": len(messages),
        "messages": messages,
    }
    export["chats"].append(chat_record)
    markdown.append(f"## {row['title'] or '[untitled]'}")
    markdown.append("")
    markdown.append(f"- Chat ID: {row['id']}")
    markdown.append(f"- User ID: {row['user_id'] or '-'}")
    markdown.append(f"- User: {row['user_name'] or '-'} <{row['user_email'] or '-'}>")
    markdown.append(f"- Created: {chat_record['created_at']}")
    markdown.append(f"- Updated: {chat_record['updated_at']}")
    markdown.append(f"- Models: {', '.join(map(str, chat_record['models'] or [])) or '-'}")
    markdown.append(f"- Messages: {len(messages)}")
    markdown.append("")
    for msg in messages:
        markdown.append(f"### {msg.get('role') or 'unknown'}")
        markdown.append("")
        if msg.get("model"):
            markdown.append(f"_model: {msg['model']}_")
            markdown.append("")
        markdown.append(str(msg.get("content") or ""))
        markdown.append("")
    markdown.append("")

json_path = os.path.join(OUT, "openwebui-chats-full.json")
md_path = os.path.join(OUT, "openwebui-chats-full.md")
with open(json_path, "w", encoding="utf-8") as f:
    json.dump(export, f, ensure_ascii=False, indent=2)
with open(md_path, "w", encoding="utf-8") as f:
    f.write("\n".join(markdown))

db_hashes = {}
for name in ["webui.db", "webui.db-wal", "webui.db-shm"]:
    p = os.path.join("/app/backend/data", name)
    if os.path.exists(p):
        db_hashes[name] = {
            "sha256": file_hash(p),
            "size": os.path.getsize(p),
            "mtime_utc": datetime.datetime.fromtimestamp(os.path.getmtime(p), datetime.timezone.utc).isoformat(),
        }

summary = {
    "ok": True,
    "chat_count": export["chat_count"],
    "message_count": export["message_count"],
    "users": len(users),
    "files": [os.path.basename(json_path), os.path.basename(md_path)],
    "db_hashes": db_hashes,
}
with open(os.path.join(OUT, "openwebui-db-hashes.json"), "w", encoding="utf-8") as f:
    json.dump(db_hashes, f, ensure_ascii=False, indent=2)
print(json.dumps(summary, ensure_ascii=False))
`;

module.exports = { OPENWEBUI_AUDIT_EXPORTER };
