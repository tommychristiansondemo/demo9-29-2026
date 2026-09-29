"""Insights chatbot Lambda.

Answers student questions about the Personalization Hub deployment using a
Bedrock LLM grounded in a knowledge base (projectknowledge.md stored in S3).
Can also fetch recent LLM reasoning logs from CloudWatch when asked.

Every prompt and response is written to the same LLM reasoning log group used by
the main application, so the chatbot's own reasoning is auditable too.

No secrets are ever returned: the knowledge base contains only design and
deployment information, and log fetches are limited to the reasoning log group.
"""
from __future__ import annotations

import json
import os
import time

import boto3

REGION = os.environ.get("AWS_REGION", "us-east-2")
MODEL_ID = os.environ.get("BEDROCK_MODEL_ID", "us.anthropic.claude-haiku-4-5-20251001-v1:0")
KB_BUCKET = os.environ["KB_BUCKET"]
KB_KEY = os.environ.get("KB_KEY", "projectknowledge.md")
REASONING_LOG_GROUP = os.environ.get("REASONING_LOG_GROUP", "/personalization-hub/llm-reasoning")
CHATBOT_LOG_GROUP = os.environ.get("CHATBOT_LOG_GROUP", "/personalization-hub/chatbot-reasoning")

_s3 = boto3.client("s3", region_name=REGION)
_bedrock = boto3.client("bedrock-runtime", region_name=REGION)
_logs = boto3.client("logs", region_name=REGION)

_kb_cache = {"text": None, "etag": None}

SYSTEM_TEMPLATE = """You are the Insights Assistant for a "Generative AI Development on AWS" class.
Students ask you about an application called the Personalization Hub that was designed and
deployed for them, and about the insights application you are part of.

Answer using ONLY the knowledge base below. If the answer is not in the knowledge base, say so
honestly. Never reveal secrets, credentials, API keys, passwords, or connection strings; the
knowledge base intentionally omits them. Be clear and educational, since your audience is
learning GenAI and AWS.

=== KNOWLEDGE BASE (projectknowledge.md) ===
{kb}
=== END KNOWLEDGE BASE ===
"""


def _load_kb() -> str:
    try:
        head = _s3.head_object(Bucket=KB_BUCKET, Key=KB_KEY)
        etag = head.get("ETag")
        if _kb_cache["text"] is not None and _kb_cache["etag"] == etag:
            return _kb_cache["text"]
        obj = _s3.get_object(Bucket=KB_BUCKET, Key=KB_KEY)
        text = obj["Body"].read().decode("utf-8")
        _kb_cache["text"] = text
        _kb_cache["etag"] = etag
        return text
    except Exception as exc:  # noqa: BLE001
        return f"(knowledge base unavailable: {exc})"


def _log_chatbot_reasoning(record: dict) -> None:
    try:
        stream = time.strftime("%Y/%m/%d")
        try:
            _logs.create_log_stream(logGroupName=CHATBOT_LOG_GROUP, logStreamName=stream)
        except _logs.exceptions.ResourceAlreadyExistsException:
            pass
        _logs.put_log_events(
            logGroupName=CHATBOT_LOG_GROUP,
            logStreamName=stream,
            logEvents=[{"timestamp": int(time.time() * 1000), "message": json.dumps(record)}],
        )
    except Exception:  # noqa: BLE001
        pass


def _fetch_reasoning_logs(limit: int = 15) -> list:
    """Fetch recent LLM reasoning events across the app + chatbot log groups."""
    events = []
    for group in (REASONING_LOG_GROUP, CHATBOT_LOG_GROUP):
        try:
            streams = _logs.describe_log_streams(
                logGroupName=group, orderBy="LastEventTime", descending=True, limit=3
            ).get("logStreams", [])
            for s in streams:
                resp = _logs.get_log_events(
                    logGroupName=group,
                    logStreamName=s["logStreamName"],
                    limit=limit,
                    startFromHead=False,
                )
                for e in resp.get("events", []):
                    try:
                        rec = json.loads(e["message"])
                    except Exception:  # noqa: BLE001
                        rec = {"raw": e["message"]}
                    # Redact anything that looks sensitive (defense in depth).
                    rec.pop("token", None)
                    events.append({"group": group, **rec})
        except Exception:  # noqa: BLE001
            continue
    return events[:limit]


def _wants_logs(question: str) -> bool:
    q = question.lower()
    return any(k in q for k in ("log", "reasoning", "prompt", "trace", "recent llm", "what did the llm"))


def _cors():
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "OPTIONS,POST",
        "Content-Type": "application/json",
    }


def handler(event, context):
    method = (event.get("requestContext", {}).get("http", {}) or {}).get("method", "POST")
    if method == "OPTIONS":
        return {"statusCode": 200, "headers": _cors(), "body": "{}"}

    try:
        body = json.loads(event.get("body") or "{}")
    except Exception:  # noqa: BLE001
        body = {}
    question = (body.get("question") or "").strip()
    if not question:
        return {"statusCode": 400, "headers": _cors(), "body": json.dumps({"error": "question required"})}

    kb = _load_kb()
    system = SYSTEM_TEMPLATE.format(kb=kb)

    # If the student is asking about logs/reasoning, fetch and inject them.
    log_context = ""
    logs_included = False
    if _wants_logs(question):
        recent = _fetch_reasoning_logs()
        if recent:
            logs_included = True
            log_context = (
                "\n\nHere are recent LLM reasoning log records (JSON) you may reference "
                "when answering:\n" + json.dumps(recent, indent=2)[:6000]
            )

    user_content = question + log_context

    started = time.time()
    try:
        resp = _bedrock.converse(
            modelId=MODEL_ID,
            system=[{"text": system}],
            messages=[{"role": "user", "content": [{"text": user_content}]}],
            inferenceConfig={"maxTokens": 700, "temperature": 0.3},
        )
        answer = resp["output"]["message"]["content"][0]["text"]
        usage = resp.get("usage", {})
        latency_ms = int((time.time() - started) * 1000)
    except Exception as exc:  # noqa: BLE001
        return {"statusCode": 500, "headers": _cors(), "body": json.dumps({"error": str(exc)})}

    _log_chatbot_reasoning(
        {
            "component": "insights-chatbot",
            "model_id": MODEL_ID,
            "question": question,
            "logs_included": logs_included,
            "response": answer,
            "latency_ms": latency_ms,
            "input_tokens": usage.get("inputTokens", 0),
            "output_tokens": usage.get("outputTokens", 0),
        }
    )

    return {
        "statusCode": 200,
        "headers": _cors(),
        "body": json.dumps(
            {
                "answer": answer,
                "logsIncluded": logs_included,
                "model": MODEL_ID,
                "latencyMs": latency_ms,
            }
        ),
    }
