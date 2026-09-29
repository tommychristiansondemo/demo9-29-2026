"""Integration tests for the recommendation DB layer against a real Postgres.

Skips automatically if TEST_DATABASE_URL is not set.
"""
from __future__ import annotations

import os

import pytest

from rec import db

DSN = os.environ.get("TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not DSN, reason="TEST_DATABASE_URL not set")


@pytest.fixture()
def conn():
    c = db.connect(DSN)
    db.init_schema(c)
    # Clean slate.
    with c.cursor() as cur:
        cur.execute("TRUNCATE item, app_user, interaction, experiment_assignment, impression CASCADE;")
    yield c
    c.close()


def _make_user(conn, email="a@example.com", admin=False):
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO app_user (email, display_name, password_hash, is_admin) VALUES (%s,%s,%s,%s) RETURNING id",
            (email, "A", "x", admin),
        )
        return str(cur.fetchone()["id"])


def _make_item(conn, title="T", pop=1.0):
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO item (title, type, url, popularity_score) VALUES (%s,'article','http://x',%s) RETURNING id",
            (title, pop),
        )
        return str(cur.fetchone()["id"])


def test_idempotent_assignment(conn):
    """Property 10: recording the same assignment twice yields one row."""
    user_id = _make_user(conn)
    db.upsert_assignment(conn, "rec_strategy_ab", user_id, "treatment")
    db.upsert_assignment(conn, "rec_strategy_ab", user_id, "treatment")
    with conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) AS n FROM experiment_assignment WHERE user_id=%s", (user_id,))
        assert cur.fetchone()["n"] == 1


def test_completed_items_excluded(conn):
    user_id = _make_user(conn)
    keep = _make_item(conn, "keep", 0.9)
    done = _make_item(conn, "done", 0.9)
    db.record_interaction(conn, user_id, done, "complete")
    candidates = db.get_candidate_items(conn, user_id)
    ids = {c.id for c in candidates}
    assert keep in ids
    assert done not in ids


def test_interaction_weight_mapping(conn):
    user_id = _make_user(conn)
    item_id = _make_item(conn)
    db.record_interaction(conn, user_id, item_id, "click")
    with conn.cursor() as cur:
        cur.execute("SELECT weight FROM interaction WHERE user_id=%s", (user_id,))
        assert cur.fetchone()["weight"] == 3.0


def test_flag_update(conn):
    flag = db.update_flag(conn, "recommendation_strategy", True, 25)
    assert flag.enabled is True
    assert flag.rollout_percent == 25
