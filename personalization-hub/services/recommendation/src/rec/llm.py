"""Bedrock-backed LLM explanation generation for recommendations.

This module turns the raw recommendation signals (the user's recent activity,
the candidate item, the strategy and score) into a short, personalized natural
language explanation using Amazon Bedrock (Claude via an inference profile).

Every prompt and response is logged to a dedicated CloudWatch log group so the
"reasoning" behind each LLM call is fully auditable. No secrets or credentials
are ever logged.
"""
from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import dataclass
from typing import Optional

import boto3

logger = logging.getLogger("rec.llm")

DEFAULT_MODEL_ID = os.environ.get("BEDROCK_MODEL_ID", "us.anthropic.claude-haiku-4-5-20251001-v1:0")
REASONING_LOG_GROUP = os.environ.get("REASONING_LOG_GROUP", "/personalization-hub/llm-reasoning")
AWS_REGION = os.environ.get("AWS_REGION", "us-east-2")

# AppConfig identifiers for dynamic model selection (set via env at deploy time).
APPCONFIG_APP_ID = os.environ.get("APPCONFIG_APP_ID")
APPCONFIG_ENV_ID = os.environ.get("APPCONFIG_ENV_ID")
APPCONFIG_PROFILE_ID = os.environ.get("APPCONFIG_PROFILE_ID")


class ModelSelector:
    """Resolves the active Bedrock model id from AppConfig, cached briefly.

    Falls back to DEFAULT_MODEL_ID if AppConfig is unavailable or unconfigured,
    so the recommendation path is never blocked by config lookups.
    """

    def __init__(self, ttl_seconds: int = 30):
        self._ttl = ttl_seconds
        self._model_id = DEFAULT_MODEL_ID
        self._fetched_at = 0.0
        self._client = None
        self._token = None

    @property
    def client(self):
        if self._client is None:
            self._client = boto3.client("appconfigdata", region_name=AWS_REGION)
        return self._client

    def current_model_id(self) -> str:
        if not (APPCONFIG_APP_ID and APPCONFIG_ENV_ID and APPCONFIG_PROFILE_ID):
            return self._model_id
        now = time.time()
        if now - self._fetched_at < self._ttl:
            return self._model_id
        try:
            if self._token is None:
                session = self.client.start_configuration_session(
                    ApplicationIdentifier=APPCONFIG_APP_ID,
                    EnvironmentIdentifier=APPCONFIG_ENV_ID,
                    ConfigurationProfileIdentifier=APPCONFIG_PROFILE_ID,
                )
                self._token = session["InitialConfigurationToken"]
            resp = self.client.get_latest_configuration(ConfigurationToken=self._token)
            self._token = resp["NextPollConfigurationToken"]
            raw = resp["Configuration"].read()
            if raw:
                cfg = json.loads(raw)
                self._model_id = cfg.get("selectedModelId", self._model_id)
            self._fetched_at = now
        except Exception as exc:  # noqa: BLE001
            logger.warning("AppConfig model lookup failed, using %s: %s", self._model_id, exc)
        return self._model_id


_selector = ModelSelector()

SYSTEM_PROMPT = (
    "You are the recommendation explainer for the GoTo Learning Center, an internal "
    "content hub. Given a learner's recent activity and a recommended content item, "
    "write a single friendly sentence (max 30 words) explaining why this item is a good "
    "next step for them. Be specific and reference their history when relevant. Do not "
    "invent facts about the content. Output only the sentence, no preamble."
)


@dataclass
class ExplanationResult:
    item_id: str
    explanation: str
    model_id: str
    latency_ms: int
    input_tokens: int
    output_tokens: int


class BedrockExplainer:
    def __init__(self, client=None, logs_client=None):
        self._client = client
        self._logs = logs_client
        self._stream_ensured = False

    @property
    def client(self):
        if self._client is None:
            self._client = boto3.client("bedrock-runtime", region_name=AWS_REGION)
        return self._client

    @property
    def logs(self):
        if self._logs is None:
            self._logs = boto3.client("logs", region_name=AWS_REGION)
        return self._logs

    def _log_reasoning(self, record: dict) -> None:
        """Write a structured reasoning record to CloudWatch Logs.

        Best-effort: logging failures never break the recommendation path.
        """
        try:
            stream = time.strftime("%Y/%m/%d")
            if not self._stream_ensured:
                try:
                    self.logs.create_log_stream(
                        logGroupName=REASONING_LOG_GROUP, logStreamName=stream
                    )
                except self.logs.exceptions.ResourceAlreadyExistsException:
                    pass
                except Exception:  # noqa: BLE001
                    pass
                self._stream_ensured = True
            self.logs.put_log_events(
                logGroupName=REASONING_LOG_GROUP,
                logStreamName=stream,
                logEvents=[
                    {"timestamp": int(time.time() * 1000), "message": json.dumps(record)}
                ],
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("could not write reasoning log: %s", exc)

    def explain(
        self,
        user_id: str,
        item_title: str,
        item_type: str,
        base_reason: str,
        recent_titles: list[str],
    ) -> Optional[ExplanationResult]:
        history = ", ".join(recent_titles[:5]) if recent_titles else "no prior activity"
        user_prompt = (
            f"Learner recent activity: {history}.\n"
            f"Recommended item: '{item_title}' (type: {item_type}).\n"
            f"Underlying signal: {base_reason}.\n"
            "Write the one-sentence explanation."
        )
        model_id = _selector.current_model_id()
        started = time.time()
        try:
            resp = self.client.converse(
                modelId=model_id,
                system=[{"text": SYSTEM_PROMPT}],
                messages=[{"role": "user", "content": [{"text": user_prompt}]}],
                inferenceConfig={"maxTokens": 120, "temperature": 0.4},
            )
            latency_ms = int((time.time() - started) * 1000)
            text = resp["output"]["message"]["content"][0]["text"].strip()
            usage = resp.get("usage", {})
            result = ExplanationResult(
                item_id=item_title,
                explanation=text,
                model_id=model_id,
                latency_ms=latency_ms,
                input_tokens=usage.get("inputTokens", 0),
                output_tokens=usage.get("outputTokens", 0),
            )
            # Reasoning log: the full prompt and response for auditability.
            self._log_reasoning(
                {
                    "component": "recommendation-explainer",
                    "user_id": user_id,
                    "model_id": model_id,
                    "system_prompt": SYSTEM_PROMPT,
                    "user_prompt": user_prompt,
                    "response": text,
                    "latency_ms": latency_ms,
                    "input_tokens": result.input_tokens,
                    "output_tokens": result.output_tokens,
                }
            )
            return result
        except Exception as exc:  # noqa: BLE001
            logger.error("bedrock explain failed: %s", exc)
            self._log_reasoning(
                {
                    "component": "recommendation-explainer",
                    "user_id": user_id,
                    "model_id": model_id,
                    "user_prompt": user_prompt,
                    "error": str(exc),
                }
            )
            return None
