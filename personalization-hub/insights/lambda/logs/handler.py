"""Logs API Lambda.

Returns recent LLM reasoning log records (from the main app's recommendation
explainer and the insights chatbot) as structured JSON for the insights UI to
render. Read-only, scoped to the two reasoning log groups. Redacts sensitive
fields defensively.
"""
from __future__ import annotations

import json
import os

import boto3

REGION = os.environ.get("AWS_REGION", "us-east-2")
REASONING_LOG_GROUP = os.environ.get("REASONING_LOG_GROUP", "/personalization-hub/llm-reasoning")
CHATBOT_LOG_GROUP = os.environ.get("CHATBOT_LOG_GROUP", "/personalization-hub/chatbot-reasoning")

_logs = boto3.client("logs", region_name=REGION)

REDACT = {"token", "password", "secret", "authorization"}


def _cors():
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "OPTIONS,GET",
        "Content-Type": "application/json",
    }


def _collect(group: str, limit: int) -> list:
    out = []
    try:
        streams = _logs.describe_log_streams(
            logGroupName=group, orderBy="LastEventTime", descending=True, limit=5
        ).get("logStreams", [])
        for s in streams:
            resp = _logs.get_log_events(
                logGroupName=group, logStreamName=s["logStreamName"], limit=limit, startFromHead=False
            )
            for e in resp.get("events", []):
                try:
                    rec = json.loads(e["message"])
                except Exception:  # noqa: BLE001
                    rec = {"raw": e["message"]}
                for k in list(rec.keys()):
                    if k.lower() in REDACT:
                        rec[k] = "***redacted***"
                rec["_timestamp"] = e["timestamp"]
                out.append(rec)
    except Exception:  # noqa: BLE001
        pass
    return out


def handler(event, context):
    method = (event.get("requestContext", {}).get("http", {}) or {}).get("method", "GET")
    if method == "OPTIONS":
        return {"statusCode": 200, "headers": _cors(), "body": "{}"}

    app_logs = _collect(REASONING_LOG_GROUP, 20)
    bot_logs = _collect(CHATBOT_LOG_GROUP, 20)
    combined = sorted(app_logs + bot_logs, key=lambda r: r.get("_timestamp", 0), reverse=True)[:40]

    return {
        "statusCode": 200,
        "headers": _cors(),
        "body": json.dumps({"count": len(combined), "events": combined}),
    }
