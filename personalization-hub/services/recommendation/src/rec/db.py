"""Database layer for the recommendation service (psycopg 3)."""
from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Optional

import psycopg
from psycopg.rows import dict_row

from .domain import EVENT_WEIGHTS, FeatureFlag, Item

SCHEMA = """
CREATE TABLE IF NOT EXISTS item (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('article','video','doc')),
    tags JSONB NOT NULL DEFAULT '[]'::jsonb,
    url TEXT NOT NULL,
    popularity_score DOUBLE PRECISION NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_user (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    is_admin BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS interaction (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    item_id UUID NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN ('view','click','complete')),
    weight DOUBLE PRECISION NOT NULL CHECK (weight > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_interaction_user ON interaction(user_id);

CREATE TABLE IF NOT EXISTS feature_flag (
    key TEXT PRIMARY KEY,
    enabled BOOLEAN NOT NULL,
    default_variant TEXT NOT NULL,
    rollout_percent INT NOT NULL CHECK (rollout_percent BETWEEN 0 AND 100),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS experiment_assignment (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    experiment_key TEXT NOT NULL,
    user_id UUID NOT NULL,
    variant TEXT NOT NULL,
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (experiment_key, user_id)
);

CREATE TABLE IF NOT EXISTS impression (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    item_ids JSONB NOT NULL,
    strategy TEXT NOT NULL,
    variant TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO feature_flag (key, enabled, default_variant, rollout_percent)
VALUES ('recommendation_strategy', true, 'rule-based', 50)
ON CONFLICT (key) DO NOTHING;
"""


def database_url() -> str:
    """Resolve the DSN from DATABASE_URL or from discrete DB_* parts."""
    if os.environ.get("DATABASE_URL"):
        return os.environ["DATABASE_URL"]
    user = os.environ["DB_USER"]
    password = os.environ["DB_PASS"]
    host = os.environ["DB_HOST"]
    port = os.environ.get("DB_PORT", "5432")
    name = os.environ.get("DB_NAME", "personalize")
    # RDS requires TLS.
    return f"postgresql://{user}:{password}@{host}:{port}/{name}?sslmode=require"


def connect(dsn: Optional[str] = None) -> psycopg.Connection:
    dsn = dsn or database_url()
    return psycopg.connect(dsn, row_factory=dict_row, autocommit=True)


def init_schema(conn: psycopg.Connection) -> None:
    with conn.cursor() as cur:
        cur.execute("CREATE EXTENSION IF NOT EXISTS pgcrypto;")
        cur.execute(SCHEMA)


def get_flag(conn: psycopg.Connection, key: str) -> FeatureFlag:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT key, enabled, default_variant, rollout_percent FROM feature_flag WHERE key = %s",
            (key,),
        )
        row = cur.fetchone()
    if row is None:
        # Safe default: rule-based, disabled.
        return FeatureFlag(key, False, "rule-based", 0)
    return FeatureFlag(row["key"], row["enabled"], row["default_variant"], row["rollout_percent"])


def update_flag(conn: psycopg.Connection, key: str, enabled: bool, rollout_percent: int) -> FeatureFlag:
    with conn.cursor() as cur:
        cur.execute(
            """UPDATE feature_flag SET enabled=%s, rollout_percent=%s, updated_at=now()
               WHERE key=%s RETURNING key, enabled, default_variant, rollout_percent""",
            (enabled, rollout_percent, key),
        )
        row = cur.fetchone()
    return FeatureFlag(row["key"], row["enabled"], row["default_variant"], row["rollout_percent"])


def get_candidate_items(conn: psycopg.Connection, user_id: str, pool: int = 200) -> list[Item]:
    """Return candidate items excluding those the user already completed."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT i.id, i.title, i.type, i.popularity_score, i.created_at
            FROM item i
            WHERE i.id NOT IN (
                SELECT item_id FROM interaction
                WHERE user_id = %s AND event_type = 'complete'
            )
            ORDER BY i.popularity_score DESC, i.created_at DESC
            LIMIT %s
            """,
            (user_id, pool),
        )
        rows = cur.fetchall()
    return [
        Item(
            id=str(r["id"]),
            title=r["title"],
            type=r["type"],
            popularity_score=float(r["popularity_score"]),
            created_at=r["created_at"],
        )
        for r in rows
    ]


def recent_item_titles(conn: psycopg.Connection, user_id: str, limit: int = 5) -> list[str]:
    """Return titles of the user's most recently interacted items (for LLM context)."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT i.title
            FROM interaction inter
            JOIN item i ON i.id = inter.item_id
            WHERE inter.user_id = %s
            GROUP BY i.title, inter.created_at
            ORDER BY MAX(inter.created_at) DESC
            LIMIT %s
            """,
            (user_id, limit),
        )
        return [r["title"] for r in cur.fetchall()]


def record_interaction(conn: psycopg.Connection, user_id: str, item_id: str, event_type: str) -> None:
    weight = EVENT_WEIGHTS[event_type]
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO interaction (user_id, item_id, event_type, weight) VALUES (%s,%s,%s,%s)",
            (user_id, item_id, event_type, weight),
        )


def upsert_assignment(conn: psycopg.Connection, experiment_key: str, user_id: str, variant: str) -> None:
    """Idempotent: repeated calls for the same (experiment_key, user_id) do not duplicate."""
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO experiment_assignment (experiment_key, user_id, variant)
               VALUES (%s,%s,%s)
               ON CONFLICT (experiment_key, user_id) DO NOTHING""",
            (experiment_key, user_id, variant),
        )


def create_item(conn, title: str, item_type: str, url: str, tags: list, popularity: float) -> str:
    import json

    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO item (title, type, url, tags, popularity_score)
               VALUES (%s,%s,%s,%s,%s) RETURNING id""",
            (title, item_type, url, json.dumps(tags), popularity),
        )
        return str(cur.fetchone()["id"])


def list_items(conn, limit: int = 500) -> list:
    with conn.cursor() as cur:
        cur.execute("SELECT id, title, type FROM item ORDER BY created_at DESC LIMIT %s", (limit,))
        return [{"id": str(r["id"]), "title": r["title"], "type": r["type"]} for r in cur.fetchall()]


def record_impression(conn, user_id, item_ids, strategy, variant) -> None:
    import json

    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO impression (user_id, item_ids, strategy, variant) VALUES (%s,%s,%s,%s)",
            (user_id, json.dumps(item_ids), strategy, variant),
        )


def ctr_by_variant(conn: psycopg.Connection, experiment_key: str = "rec_strategy_ab") -> list[dict]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT ea.variant,
                   COUNT(DISTINCT i.user_id) AS users,
                   COALESCE(
                     SUM(CASE WHEN i.event_type='click' THEN 1 ELSE 0 END)::float
                     / NULLIF(SUM(CASE WHEN i.event_type='view' THEN 1 ELSE 0 END), 0), 0) AS ctr
            FROM experiment_assignment ea
            LEFT JOIN interaction i ON i.user_id = ea.user_id
            WHERE ea.experiment_key = %s
            GROUP BY ea.variant
            """,
            (experiment_key,),
        )
        return cur.fetchall()
