"""Managed categories: the registry of the category names transactions, templates and payee
rules carry. Shaped like the ledger design's `categories`, which reuses this table.

The name stays on the rows that use it; rename and merge rewrite those rows with this one. A
merged category keeps its row (`merged_into_id`), so an old name still finds its new home.
"""

import datetime as dt

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    String,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class Category(Base):
    __tablename__ = "categories"
    __table_args__ = (
        UniqueConstraint("id", "user_id", "kind"),
        ForeignKeyConstraint(
            ["parent_id", "user_id", "kind"],
            ["categories.id", "categories.user_id", "categories.kind"],
        ),
        ForeignKeyConstraint(
            ["merged_into_id", "user_id", "kind"],
            ["categories.id", "categories.user_id", "categories.kind"],
        ),
        CheckConstraint("kind IN ('income', 'expense')", name="kind"),
        CheckConstraint("parent_id <> id", name="not_own_parent"),
        CheckConstraint("merged_into_id <> id", name="not_merged_into_itself"),
        # One live category per name (ignoring case) and kind; merged ones free their name.
        Index(
            "uq_categories_live_name",
            "user_id",
            "kind",
            "name_key",
            unique=True,
            postgresql_where=text("merged_into_id IS NULL"),
            sqlite_where=text("merged_into_id IS NULL"),
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    kind: Mapped[str] = mapped_column(String(10))  # "income" or "expense"
    name: Mapped[str] = mapped_column(String(40))
    # `name` case-folded, so "food" and "Food" are one category.
    name_key: Mapped[str] = mapped_column(String(40))
    parent_id: Mapped[int | None] = mapped_column()
    merged_into_id: Mapped[int | None] = mapped_column()
    # A key from `app.api.categories.ICONS`; each client maps it to its own icon set.
    icon: Mapped[str | None] = mapped_column(String(20))
    colour: Mapped[str | None] = mapped_column(String(7))  # "#rrggbb"
    archived_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
