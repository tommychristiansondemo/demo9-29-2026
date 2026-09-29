"""Offline ALS collaborative-filtering training job.

Reads interactions from RDS, snapshots them to S3, trains an implicit-feedback
ALS model with NumPy, evaluates recall@k, and publishes a versioned artifact
plus metadata to S3. On failure the previously published artifact is left intact
(we only update models/latest.json after a successful publish).
"""
from __future__ import annotations

import io
import json
import logging
import os
import pickle
from datetime import datetime, timezone

import boto3
import numpy as np
import psycopg
from psycopg.rows import dict_row

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("training")

BUCKET = os.environ.get("MODEL_BUCKET", "")
LATEST_KEY = "models/latest.json"


def database_url() -> str:
    if os.environ.get("DATABASE_URL"):
        return os.environ["DATABASE_URL"]
    user = os.environ["DB_USER"]
    password = os.environ["DB_PASS"]
    host = os.environ["DB_HOST"]
    port = os.environ.get("DB_PORT", "5432")
    name = os.environ.get("DB_NAME", "personalize")
    return f"postgresql://{user}:{password}@{host}:{port}/{name}?sslmode=require"


def fetch_interactions(dsn: str):
    with psycopg.connect(dsn, row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT user_id, item_id, SUM(weight) AS w FROM interaction GROUP BY user_id, item_id")
            return [(str(r["user_id"]), str(r["item_id"]), float(r["w"])) for r in cur.fetchall()]


def build_matrix(interactions):
    users = sorted({u for u, _, _ in interactions})
    items = sorted({i for _, i, _ in interactions})
    user_index = {u: idx for idx, u in enumerate(users)}
    item_index = {i: idx for idx, i in enumerate(items)}
    R = np.zeros((len(users), len(items)), dtype=np.float64)
    for u, i, w in interactions:
        R[user_index[u], item_index[i]] = w
    return user_index, item_index, R


def train_als(R, num_factors=16, iterations=15, reg=0.1, alpha=40.0, seed=42):
    """Implicit-feedback ALS (Hu, Koren, Volinsky)."""
    rng = np.random.default_rng(seed)
    n_users, n_items = R.shape
    C = 1.0 + alpha * R
    P = (R > 0).astype(np.float64)

    U = rng.normal(0, 0.01, size=(n_users, num_factors))
    V = rng.normal(0, 0.01, size=(n_items, num_factors))
    reg_eye = reg * np.eye(num_factors)

    for _ in range(iterations):
        # Solve users with V fixed.
        VtV = V.T @ V
        for u in range(n_users):
            Cu = C[u]
            A = VtV + (V.T * (Cu - 1.0)) @ V + reg_eye
            b = (V.T * Cu) @ P[u]
            U[u] = np.linalg.solve(A, b)
        # Solve items with U fixed.
        UtU = U.T @ U
        for i in range(n_items):
            Ci = C[:, i]
            A = UtU + (U.T * (Ci - 1.0)) @ U + reg_eye
            b = (U.T * Ci) @ P[:, i]
            V[i] = np.linalg.solve(A, b)
    return U, V


def recall_at_k(U, V, R, k=5):
    if U.shape[0] == 0 or V.shape[0] == 0:
        return 0.0
    scores = U @ V.T
    hits = 0
    total = 0
    for u in range(R.shape[0]):
        positives = np.where(R[u] > 0)[0]
        if len(positives) == 0:
            continue
        topk = np.argsort(-scores[u])[:k]
        hits += len(set(topk) & set(positives))
        total += min(k, len(positives))
    return hits / total if total else 0.0


def publish(s3, user_index, item_index, U, V, metrics):
    version = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    artifact_key = f"models/model-{version}.pkl"
    payload = {
        "user_index": user_index,
        "item_index": item_index,
        "user_factors": U,
        "item_factors": V,
    }
    buf = io.BytesIO()
    pickle.dump(payload, buf)
    s3.put_object(Bucket=BUCKET, Key=artifact_key, Body=buf.getvalue())

    meta = {
        "version": version,
        "artifactKey": artifact_key,
        "algorithm": "implicit-als",
        "trainedAt": version,
        "metrics": metrics,
    }
    # Update latest pointer only after the artifact is safely uploaded.
    s3.put_object(Bucket=BUCKET, Key=LATEST_KEY, Body=json.dumps(meta).encode())
    return meta


def emit_metric(name, value):
    try:
        cw = boto3.client("cloudwatch")
        cw.put_metric_data(
            Namespace="PersonalizationHub/Training",
            MetricData=[{"MetricName": name, "Value": value}],
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("could not emit metric %s: %s", name, exc)


def main():
    dsn = database_url()
    s3 = boto3.client("s3")
    try:
        interactions = fetch_interactions(dsn)
        if not interactions:
            logger.warning("no interactions available; skipping training")
            emit_metric("TrainingSkipped", 1)
            return
        # Snapshot for reproducibility.
        snap_key = f"snapshots/interactions-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.json"
        s3.put_object(Bucket=BUCKET, Key=snap_key, Body=json.dumps(interactions).encode())

        user_index, item_index, R = build_matrix(interactions)
        U, V = train_als(R)
        metrics = {
            "recallAtK": recall_at_k(U, V, R, k=5),
            "k": 5,
            "numUsers": len(user_index),
            "numItems": len(item_index),
        }
        meta = publish(s3, user_index, item_index, U, V, metrics)
        logger.info("published model %s metrics=%s", meta["version"], metrics)
        emit_metric("TrainingSuccess", 1)
        emit_metric("RecallAtK", metrics["recallAtK"])
    except Exception as exc:  # noqa: BLE001
        logger.exception("training failed: %s", exc)
        emit_metric("TrainingFailure", 1)
        raise


if __name__ == "__main__":
    main()
