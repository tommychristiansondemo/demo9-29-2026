"""Core recommendation domain logic (pure, testable).

This module contains the strategy resolution, scoring, and ranking logic that
the design's Correctness Properties are defined against. It has no I/O so it can
be exercised directly by property-based tests.
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Literal, Optional, Protocol

Strategy = Literal["rule-based", "ml-based", "llm-enhanced"]

# Implicit-feedback weights: view < click < complete
EVENT_WEIGHTS: dict[str, float] = {"view": 1.0, "click": 3.0, "complete": 5.0}


@dataclass(frozen=True)
class FeatureFlag:
    key: str
    enabled: bool
    default_variant: str
    rollout_percent: int  # 0..100

    def __post_init__(self) -> None:
        if not (0 <= self.rollout_percent <= 100):
            raise ValueError("rollout_percent must be within [0, 100]")


@dataclass(frozen=True)
class Item:
    id: str
    title: str
    type: str
    popularity_score: float
    created_at: datetime


@dataclass
class RecommendedItem:
    item_id: str
    title: str
    score: float
    reason: str


@dataclass
class RecommendationResponse:
    user_id: str
    strategy: Strategy
    experiment_variant: Optional[str]
    items: list[RecommendedItem] = field(default_factory=list)


@dataclass(frozen=True)
class InteractionEvent:
    user_id: str
    item_id: str
    event_type: Literal["view", "click", "complete"]

    @property
    def weight(self) -> float:
        return EVENT_WEIGHTS[self.event_type]


class Model(Protocol):
    """Trained collaborative-filtering model interface."""

    def has_user(self, user_id: str) -> bool: ...
    def has_item(self, item_id: str) -> bool: ...
    def score(self, user_id: str, item_id: str) -> float: ...


def _stable_bucket(key: str, user_id: str) -> int:
    """Deterministic bucket in [0, 99] from a stable hash of key + user_id."""
    digest = hashlib.sha256(f"{key}:{user_id}".encode("utf-8")).digest()
    # Use the first 8 bytes as an unsigned integer.
    value = int.from_bytes(digest[:8], "big")
    return value % 100


def resolve_strategy(
    user_id: str, flag: FeatureFlag, treatment_strategy: Strategy = "ml-based"
) -> tuple[Strategy, Optional[str]]:
    """Resolve the recommendation strategy for a user.

    Deterministic and sticky: the same (flag, user_id) always yields the same
    result. When the flag is disabled, everyone gets the default variant and no
    experiment assignment is produced.

    `treatment_strategy` selects which strategy the treatment group receives
    (e.g. "ml-based" or "llm-enhanced"); control is always "rule-based".
    """
    if not flag.enabled:
        strategy: Strategy = (
            "rule-based" if flag.default_variant == "rule-based" else treatment_strategy
        )
        return strategy, None

    bucket = _stable_bucket(flag.key, user_id)
    if bucket < flag.rollout_percent:
        return treatment_strategy, "treatment"
    return "rule-based", "control"


def _age_in_days(created_at: datetime, now: datetime) -> float:
    delta = now - created_at
    return max(delta.total_seconds() / 86400.0, 0.0)


def score_items_rule_based(
    candidates: list[Item], now: Optional[datetime] = None
) -> list[RecommendedItem]:
    """Popularity + recency scoring (control / fallback strategy)."""
    now = now or datetime.now(timezone.utc)
    result: list[RecommendedItem] = []
    for item in candidates:
        recency = 1.0 / (1.0 + _age_in_days(item.created_at, now))
        score = item.popularity_score * 0.7 + recency * 0.3
        result.append(
            RecommendedItem(item.id, item.title, score, reason="popular + recent")
        )
    return result


def score_items_ml(
    user_id: str, candidates: list[Item], model: Model
) -> list[RecommendedItem]:
    """Collaborative-filtering scoring.

    Returns an empty list for cold-start users (unknown to the model), so the
    caller can fall back to rule-based. Scores are guaranteed finite.
    """
    import math

    if not model.has_user(user_id):
        return []

    result: list[RecommendedItem] = []
    for item in candidates:
        if model.has_item(item.id):
            score = model.score(user_id, item.id)
            if not math.isfinite(score):
                continue
            result.append(
                RecommendedItem(
                    item.id, item.title, float(score), reason="collaborative filtering"
                )
            )
    return result


def rank_and_take(items: list[RecommendedItem], limit: int) -> list[RecommendedItem]:
    """Deduplicate by item_id, sort by score descending, and take at most `limit`.

    Ordering is stable and deterministic: ties break by item_id to keep results
    reproducible.
    """
    if limit < 1:
        return []
    seen: set[str] = set()
    deduped: list[RecommendedItem] = []
    for it in items:
        if it.item_id not in seen:
            seen.add(it.item_id)
            deduped.append(it)
    deduped.sort(key=lambda r: (-r.score, r.item_id))
    return deduped[:limit]
