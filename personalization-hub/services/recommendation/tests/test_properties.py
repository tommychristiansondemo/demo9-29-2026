"""Property-based tests encoding the design's Correctness Properties."""
from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone

from hypothesis import given, settings
from hypothesis import strategies as st

from rec.domain import (
    FeatureFlag,
    Item,
    RecommendedItem,
    resolve_strategy,
    rank_and_take,
    score_items_ml,
    score_items_rule_based,
)

NOW = datetime(2025, 1, 1, tzinfo=timezone.utc)

item_strategy = st.builds(
    Item,
    id=st.uuids().map(str),
    title=st.text(min_size=1, max_size=20),
    type=st.sampled_from(["article", "video", "doc"]),
    popularity_score=st.floats(min_value=0, max_value=1, allow_nan=False, allow_infinity=False),
    created_at=st.integers(min_value=0, max_value=3650).map(
        lambda d: NOW - timedelta(days=d)
    ),
)

# Unique items by id so cardinality/distinctness tests are meaningful.
items_strategy = st.lists(item_strategy, min_size=0, max_size=50, unique_by=lambda i: i.id)


class FakeModel:
    """Deterministic model over a fixed set of users/items."""

    def __init__(self, users: set[str], items: set[str], scores: dict):
        self._users = users
        self._items = items
        self._scores = scores

    def has_user(self, user_id: str) -> bool:
        return user_id in self._users

    def has_item(self, item_id: str) -> bool:
        return item_id in self._items

    def score(self, user_id: str, item_id: str) -> float:
        return self._scores.get((user_id, item_id), 0.0)


# Property 1: cardinality  (Req 3.1)
@given(items=items_strategy, limit=st.integers(min_value=1, max_value=100))
def test_property_cardinality(items, limit):
    scored = score_items_rule_based(items, now=NOW)
    result = rank_and_take(scored, limit)
    assert len(result) <= limit


# Property 2: distinctness  (Req 3.2)
@given(items=items_strategy, limit=st.integers(min_value=1, max_value=100))
def test_property_distinctness(items, limit):
    scored = score_items_rule_based(items, now=NOW)
    result = rank_and_take(scored, limit)
    ids = [r.item_id for r in result]
    assert len(ids) == len(set(ids))


# Property 3: ordering  (Req 3.3)
@given(items=items_strategy, limit=st.integers(min_value=1, max_value=100))
def test_property_ordering(items, limit):
    scored = score_items_rule_based(items, now=NOW)
    result = rank_and_take(scored, limit)
    scores = [r.score for r in result]
    assert scores == sorted(scores, reverse=True)


# Property 8: finite scores  (Req 3.5)
@given(items=items_strategy)
def test_property_finite_scores(items):
    users = {"u1"}
    item_ids = {i.id for i in items}
    scores = {("u1", i.id): (hash(i.id) % 1000) / 100.0 for i in items}
    model = FakeModel(users, item_ids, scores)
    result = score_items_ml("u1", items, model)
    assert all(math.isfinite(r.score) for r in result)


# Property 9: cold-start fallback  (Req 3.6)
@given(items=items_strategy, limit=st.integers(min_value=1, max_value=100))
def test_property_cold_start_fallback(items, limit):
    model = FakeModel(set(), set(), {})  # knows no users
    ml = score_items_ml("unknown-user", items, model)
    assert ml == []
    # Fallback to rule-based still satisfies cardinality/distinctness/ordering.
    fallback = rank_and_take(score_items_rule_based(items, now=NOW), limit)
    ids = [r.item_id for r in fallback]
    assert len(fallback) <= limit
    assert len(ids) == len(set(ids))
    assert [r.score for r in fallback] == sorted((r.score for r in fallback), reverse=True)


# Property 5: sticky assignment  (Req 4.1)
@given(
    user_id=st.text(min_size=1, max_size=40),
    rollout=st.integers(min_value=0, max_value=100),
)
def test_property_sticky_assignment(user_id, rollout):
    flag = FeatureFlag("recommendation_strategy", True, "rule-based", rollout)
    first = resolve_strategy(user_id, flag)
    for _ in range(5):
        assert resolve_strategy(user_id, flag) == first


# Property 7: flag off  (Req 4.2)
@given(user_id=st.text(min_size=1, max_size=40))
def test_property_flag_off(user_id):
    flag = FeatureFlag("recommendation_strategy", False, "rule-based", 100)
    strategy, variant = resolve_strategy(user_id, flag)
    assert strategy == "rule-based"
    assert variant is None


# Property 6: rollout proportionality  (Req 5.1)
@settings(max_examples=10)
@given(rollout=st.integers(min_value=0, max_value=100))
def test_property_rollout_proportionality(rollout):
    flag = FeatureFlag("recommendation_strategy", True, "rule-based", rollout)
    n = 5000
    treatment = sum(
        1 for i in range(n) if resolve_strategy(f"user-{i}", flag)[1] == "treatment"
    )
    fraction = treatment / n
    # Allow a tolerance band around the target proportion.
    assert abs(fraction - rollout / 100.0) < 0.05
