"""SQLAlchemy ORM：资源 id 使用 ULID，时间戳为 UTC naive datetime。"""
from datetime import datetime

from sqlalchemy import (Boolean, Float, ForeignKey, Index, Integer, String, Text,
                        UniqueConstraint)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from db import utcnow
from ids import ID_LEN, new_id


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"
    id: Mapped[str] = mapped_column(String(ID_LEN), primary_key=True, default=new_id)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(50))
    password_hash: Mapped[str] = mapped_column(String(200))
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False)
    is_disabled: Mapped[bool] = mapped_column(Boolean, default=False)
    # 可选自定义头像色；为空时仍由 id 哈希派生（呈现规则在 serialize.avatar_color）。
    avatar_color: Mapped[str | None] = mapped_column(String(7), nullable=True)
    created_at: Mapped[datetime] = mapped_column(default=utcnow)


class AuthSession(Base):
    __tablename__ = "sessions"
    token: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    created_at: Mapped[datetime] = mapped_column(default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(index=True)
    ip: Mapped[str | None] = mapped_column(String(45), nullable=True)
    user_agent: Mapped[str | None] = mapped_column(String(300), nullable=True)
    last_seen_at: Mapped[datetime | None] = mapped_column(nullable=True)


class Pat(Base):
    __tablename__ = "pats"
    id: Mapped[str] = mapped_column(String(ID_LEN), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    name: Mapped[str] = mapped_column(String(50))
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    scopes: Mapped[str] = mapped_column(String(20), default="read")
    last_used_at: Mapped[datetime | None] = mapped_column(nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(nullable=True)
    created_at: Mapped[datetime] = mapped_column(default=utcnow)


class Notification(Base):
    __tablename__ = "notifications"
    __table_args__ = (Index("ix_notifications_user_created", "user_id", "created_at"),)
    id: Mapped[str] = mapped_column(String(ID_LEN), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    kind: Mapped[str] = mapped_column(String(30))
    title: Mapped[str] = mapped_column(String(200))
    body: Mapped[str | None] = mapped_column(String(500), nullable=True)
    link: Mapped[str | None] = mapped_column(String(300), nullable=True)
    created_at: Mapped[datetime] = mapped_column(default=utcnow)
    read_at: Mapped[datetime | None] = mapped_column(nullable=True)


class LoginEvent(Base):
    __tablename__ = "login_events"
    __table_args__ = (Index("ix_login_events_user_created", "user_id", "created_at"),)
    id: Mapped[str] = mapped_column(String(ID_LEN), primary_key=True, default=new_id)
    user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    email: Mapped[str] = mapped_column(String(255))
    ip: Mapped[str | None] = mapped_column(String(45), nullable=True)
    user_agent: Mapped[str | None] = mapped_column(String(300), nullable=True)
    result: Mapped[str] = mapped_column(String(20))
    created_at: Mapped[datetime] = mapped_column(default=utcnow, index=True)


class ThrottleState(Base):
    __tablename__ = "throttle_state"
    key: Mapped[str] = mapped_column(String(300), primary_key=True)
    fail_count: Mapped[int] = mapped_column(Integer, default=0)
    window_start: Mapped[datetime] = mapped_column(default=utcnow)
    strikes: Mapped[int] = mapped_column(Integer, default=0)
    locked_until: Mapped[datetime | None] = mapped_column(nullable=True)
    updated_at: Mapped[datetime] = mapped_column(default=utcnow, onupdate=utcnow)


class Project(Base):
    __tablename__ = "projects"
    id: Mapped[str] = mapped_column(String(ID_LEN), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(100))
    description: Mapped[str] = mapped_column(Text, default="")
    is_personal: Mapped[bool] = mapped_column(Boolean, default=False)
    visibility: Mapped[str] = mapped_column(String(10), default="private")
    join_role: Mapped[str] = mapped_column(String(10), default="VIEWER")
    # 空间偏好：颜色可空（前端回落主题色），配额为空表示不限额，归档时间非空即只读。
    color: Mapped[str | None] = mapped_column(String(7), nullable=True)
    quota_bytes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    archived_at: Mapped[datetime | None] = mapped_column(nullable=True)
    created_by: Mapped[str | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(default=utcnow)


class ProjectMember(Base):
    __tablename__ = "project_members"
    __table_args__ = (UniqueConstraint("project_id", "user_id"),)
    id: Mapped[str] = mapped_column(String(ID_LEN), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    role: Mapped[str] = mapped_column(String(10), default="VIEWER")
    created_at: Mapped[datetime] = mapped_column(default=utcnow)


class Doc(Base):
    __tablename__ = "docs"
    __table_args__ = (Index("ix_docs_project_deleted", "project_id", "deleted_at"),)
    id: Mapped[str] = mapped_column(String(ID_LEN), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    parent_id: Mapped[str | None] = mapped_column(String(ID_LEN), nullable=True)
    title: Mapped[str] = mapped_column(String(200), default="无标题文档")
    content: Mapped[str] = mapped_column(Text, default="")
    sort: Mapped[float] = mapped_column(Float, default=0)
    version: Mapped[int] = mapped_column(Integer, default=0)
    created_by: Mapped[str | None] = mapped_column(String(ID_LEN), nullable=True)
    updated_by: Mapped[str | None] = mapped_column(String(ID_LEN), nullable=True)
    created_at: Mapped[datetime] = mapped_column(default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(default=utcnow, onupdate=utcnow)
    deleted_at: Mapped[datetime | None] = mapped_column(nullable=True)


class DocVersion(Base):
    __tablename__ = "doc_versions"
    id: Mapped[str] = mapped_column(String(ID_LEN), primary_key=True, default=new_id)
    doc_id: Mapped[str] = mapped_column(ForeignKey("docs.id"), index=True)
    content: Mapped[str] = mapped_column(Text)
    kind: Mapped[str] = mapped_column(String(20), default="save")
    created_by: Mapped[str | None] = mapped_column(String(ID_LEN), nullable=True)
    created_at: Mapped[datetime] = mapped_column(default=utcnow)


class Folder(Base):
    __tablename__ = "folders"
    id: Mapped[str] = mapped_column(String(ID_LEN), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(100))
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    parent_id: Mapped[str | None] = mapped_column(String(ID_LEN), nullable=True)
    created_at: Mapped[datetime] = mapped_column(default=utcnow)
    deleted_at: Mapped[datetime | None] = mapped_column(nullable=True)


class File(Base):
    __tablename__ = "files"
    id: Mapped[str] = mapped_column(String(ID_LEN), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(255))
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    folder_id: Mapped[str | None] = mapped_column(String(ID_LEN), nullable=True)
    size: Mapped[int] = mapped_column(Integer, default=0)
    storage_path: Mapped[str] = mapped_column(String(300), unique=True)
    version: Mapped[int] = mapped_column(Integer, default=1)
    updated_by: Mapped[str | None] = mapped_column(String(ID_LEN), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(default=utcnow, onupdate=utcnow)
    share_token: Mapped[str | None] = mapped_column(String(64), unique=True, nullable=True)
    share_expires_at: Mapped[datetime | None] = mapped_column(nullable=True)
    created_by: Mapped[str | None] = mapped_column(String(ID_LEN), nullable=True)
    created_at: Mapped[datetime] = mapped_column(default=utcnow)
    deleted_at: Mapped[datetime | None] = mapped_column(nullable=True)


class FileVersion(Base):
    __tablename__ = "file_versions"
    __table_args__ = (
        UniqueConstraint("file_id", "version"),
        Index("ix_file_versions_file", "file_id", "version"),
    )
    id: Mapped[str] = mapped_column(String(ID_LEN), primary_key=True, default=new_id)
    file_id: Mapped[str] = mapped_column(ForeignKey("files.id"), index=True)
    version: Mapped[int] = mapped_column(Integer)
    storage_path: Mapped[str] = mapped_column(String(300))
    size: Mapped[int] = mapped_column(Integer)
    # 版本备注：上传时显式填写，恢复时缺省记录来源版本。
    note: Mapped[str | None] = mapped_column(String(200), nullable=True)
    created_by: Mapped[str] = mapped_column(String(ID_LEN))
    created_at: Mapped[datetime] = mapped_column(default=utcnow)


class FileChange(Base):
    __tablename__ = "file_changes"
    __table_args__ = (Index("ix_file_changes_space_seq", "space_id", "seq"),)
    seq: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    file_id: Mapped[str] = mapped_column(String(ID_LEN), index=True)
    space_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    op: Mapped[str] = mapped_column(String(16))
    at: Mapped[datetime] = mapped_column(default=utcnow, index=True)
