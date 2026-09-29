"""Model artifact loading and in-memory caching from S3.

The recommendation service lazily loads the latest ALS model artifact from S3
and caches it. When a newer version appears, the next request reloads it. On any
load failure the cache reports no model so the caller falls back to rule-based.
"""
from __future__ import annotations

import json
import logging
import os
import pickle
import threading
from typing import Optional

import boto3

logger = logging.getLogger("rec.model_cache")

LATEST_KEY = "models/latest.json"


class ALSModel:
    """Wraps user/item latent factor matrices with index maps."""

    def __init__(self, user_index: dict, item_index: dict, user_factors, item_factors, version: str):
        self.user_index = user_index
        self.item_index = item_index
        self.user_factors = user_factors
        self.item_factors = item_factors
        self.version = version

    def has_user(self, user_id: str) -> bool:
        return user_id in self.user_index

    def has_item(self, item_id: str) -> bool:
        return item_id in self.item_index

    def score(self, user_id: str, item_id: str) -> float:
        import numpy as np

        u = self.user_factors[self.user_index[user_id]]
        v = self.item_factors[self.item_index[item_id]]
        return float(np.dot(u, v))


class ModelCache:
    def __init__(self, bucket: Optional[str] = None, s3_client=None):
        self._bucket = bucket or os.environ.get("MODEL_BUCKET", "")
        self._s3 = s3_client
        self._model: Optional[ALSModel] = None
        self._version: Optional[str] = None
        self._lock = threading.Lock()

    @property
    def s3(self):
        if self._s3 is None:
            self._s3 = boto3.client("s3")
        return self._s3

    def _read_latest_metadata(self) -> Optional[dict]:
        try:
            obj = self.s3.get_object(Bucket=self._bucket, Key=LATEST_KEY)
            return json.loads(obj["Body"].read())
        except Exception as exc:  # noqa: BLE001 - broad by design; fall back
            logger.warning("could not read latest model metadata: %s", exc)
            return None

    def get_latest(self) -> Optional[ALSModel]:
        """Return the cached model, reloading if a newer version exists."""
        if not self._bucket:
            return None
        meta = self._read_latest_metadata()
        if meta is None:
            return self._model  # keep whatever we have
        version = meta.get("version")
        if self._model is not None and version == self._version:
            return self._model
        return self._load(meta)

    def reload(self) -> Optional[dict]:
        """Force reload; returns the loaded metadata (for the admin endpoint)."""
        meta = self._read_latest_metadata()
        if meta is None:
            return None
        self._load(meta)
        return meta

    def _load(self, meta: dict) -> Optional[ALSModel]:
        with self._lock:
            try:
                artifact_key = meta["artifactKey"]
                obj = self.s3.get_object(Bucket=self._bucket, Key=artifact_key)
                payload = pickle.loads(obj["Body"].read())
                model = ALSModel(
                    user_index=payload["user_index"],
                    item_index=payload["item_index"],
                    user_factors=payload["user_factors"],
                    item_factors=payload["item_factors"],
                    version=meta["version"],
                )
                self._model = model
                self._version = meta["version"]
                logger.info("loaded model version %s", self._version)
                return model
            except Exception as exc:  # noqa: BLE001 - fall back to rule-based
                logger.error("failed to load model artifact: %s", exc)
                return self._model
