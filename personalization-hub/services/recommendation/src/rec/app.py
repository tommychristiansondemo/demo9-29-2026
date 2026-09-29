"""FastAPI application for the recommendation service."""
from __future__ import annotations

import logging
import os

from fastapi import Cookie, Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from . import auth, db
from .domain import (
    RecommendationResponse,
    resolve_strategy,
    rank_and_take,
    score_items_ml,
    score_items_rule_based,
)
from .model_cache import ModelCache
from .llm import BedrockExplainer

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("rec.app")

VERSION = os.environ.get("APP_VERSION", "dev")
EXPERIMENT_KEY = "rec_strategy_ab"

app = FastAPI(title="Personalization Hub - Recommendation Service", version=VERSION)
_model_cache = ModelCache()
_explainer = BedrockExplainer()

# Which strategy the A/B treatment group receives. Set to "llm-enhanced" to
# layer Bedrock-generated explanations on top of the ML ranking.
TREATMENT_STRATEGY = os.environ.get("TREATMENT_STRATEGY", "llm-enhanced")


def get_conn():
    conn = db.connect()
    try:
        yield conn
    finally:
        conn.close()


def require_claims(authorization: str | None = Header(default=None), auth_token: str | None = Cookie(default=None)):
    token = auth.extract_token(authorization, auth_token)
    claims = auth.verify(token) if token else None
    if claims is None:
        raise HTTPException(status_code=401, detail="unauthorized")
    return claims


def require_admin(claims=Depends(require_claims)):
    if not claims.is_admin:
        raise HTTPException(status_code=403, detail="forbidden")
    return claims


class InteractionBody(BaseModel):
    itemId: str
    eventType: str = Field(pattern="^(view|click|complete)$")


class FlagUpdateBody(BaseModel):
    enabled: bool
    rolloutPercent: int = Field(ge=0, le=100)


class ItemBody(BaseModel):
    title: str
    type: str = Field(pattern="^(article|video|doc)$")
    url: str
    tags: list[str] = []
    popularityScore: float = 0.0


@app.get("/healthz")
def healthz():
    return {"status": "ok", "version": VERSION}


@app.get("/api/recommendations")
def get_recommendations(limit: int = 10, claims=Depends(require_claims), conn=Depends(get_conn)):
    limit = max(1, min(limit, 100))
    user_id = claims.user_id

    flag = db.get_flag(conn, "recommendation_strategy")
    strategy, variant = resolve_strategy(user_id, flag, treatment_strategy=TREATMENT_STRATEGY)
    if variant is not None:
        db.upsert_assignment(conn, EXPERIMENT_KEY, user_id, variant)

    candidates = db.get_candidate_items(conn, user_id)

    # For ml-based and llm-enhanced, produce a base ML ranking (falling back to
    # rule-based for cold-start users / unavailable model). llm-enhanced then
    # layers Bedrock-generated natural-language explanations on top.
    scored = []
    if strategy in ("ml-based", "llm-enhanced"):
        model = _model_cache.get_latest()
        if model is not None:
            scored = score_items_ml(user_id, candidates, model)
        if not scored:
            if strategy == "ml-based":
                strategy = "rule-based"
            scored = score_items_rule_based(candidates)
    else:
        scored = score_items_rule_based(candidates)

    top = rank_and_take(scored, limit)

    if strategy == "llm-enhanced" and top:
        recent = db.recent_item_titles(conn, user_id)
        for item in top:
            result = _explainer.explain(
                user_id=user_id,
                item_title=item.title,
                item_type="content",
                base_reason=item.reason,
                recent_titles=recent,
            )
            if result and result.explanation:
                item.reason = result.explanation

    db.record_impression(conn, user_id, [t.item_id for t in top], strategy, variant)

    resp = RecommendationResponse(user_id=user_id, strategy=strategy, experiment_variant=variant, items=top)
    return {
        "userId": resp.user_id,
        "strategy": resp.strategy,
        "experimentVariant": resp.experiment_variant,
        "items": [
            {"itemId": i.item_id, "title": i.title, "score": i.score, "reason": i.reason}
            for i in resp.items
        ],
    }


@app.post("/api/interactions", status_code=202)
def post_interaction(body: InteractionBody, claims=Depends(require_claims), conn=Depends(get_conn)):
    db.record_interaction(conn, claims.user_id, body.itemId, body.eventType)
    return {"accepted": True}


@app.get("/api/experiments/metrics")
def experiment_metrics(claims=Depends(require_admin), conn=Depends(get_conn)):
    return {"byVariant": db.ctr_by_variant(conn, EXPERIMENT_KEY)}


@app.put("/api/flags/recommendation_strategy")
def update_flag(body: FlagUpdateBody, claims=Depends(require_admin), conn=Depends(get_conn)):
    flag = db.update_flag(conn, "recommendation_strategy", body.enabled, body.rolloutPercent)
    return {"key": flag.key, "enabled": flag.enabled, "defaultVariant": flag.default_variant, "rolloutPercent": flag.rollout_percent}


@app.get("/api/items")
def get_items(claims=Depends(require_claims), conn=Depends(get_conn)):
    return {"items": db.list_items(conn)}


@app.post("/admin/items", status_code=201)
def create_item(body: ItemBody, claims=Depends(require_admin), conn=Depends(get_conn)):
    item_id = db.create_item(conn, body.title, body.type, body.url, body.tags, body.popularityScore)
    return {"id": item_id}


@app.post("/admin/model/reload")
def reload_model(claims=Depends(require_admin)):
    meta = _model_cache.reload()
    if meta is None:
        raise HTTPException(status_code=404, detail="no model artifact available")
    return meta


@app.on_event("startup")
def _startup():
    # Initialize schema on startup so the service is self-bootstrapping.
    try:
        conn = db.connect()
        db.init_schema(conn)
        conn.close()
        logger.info("schema initialized")
    except Exception as exc:  # noqa: BLE001
        logger.error("schema init failed (will retry via health checks): %s", exc)
