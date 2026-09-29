"""Model-selector Lambda.

Reads and writes the model-preference configuration in AWS AppConfig, ranks the
five candidate LLMs according to the current weights (quality/cost/latency), and
when preferences change, deploys a new configuration version that updates the
selected model the live recommendation service uses for inference.

GET  /models  -> current weights, ranking, and selected model
POST /models  -> body {quality, cost, latency} (must sum to 100); re-ranks,
                 updates AppConfig, returns the new ranking and selected model
"""
from __future__ import annotations

import json
import os
import time

import boto3

APP_ID = os.environ["APPCONFIG_APP_ID"]
ENV_ID = os.environ["APPCONFIG_ENV_ID"]
PROFILE_ID = os.environ["APPCONFIG_PROFILE_ID"]
STRATEGY_ID = os.environ["APPCONFIG_STRATEGY_ID"]
REGION = os.environ.get("AWS_REGION", "us-east-2")

_appconfig = boto3.client("appconfig", region_name=REGION)
_appconfigdata = boto3.client("appconfigdata", region_name=REGION)


def _cors():
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "OPTIONS,GET,POST",
        "Content-Type": "application/json",
    }


def _load_config() -> dict:
    """Read the latest configuration via the AppConfig Data API."""
    session = _appconfigdata.start_configuration_session(
        ApplicationIdentifier=APP_ID,
        EnvironmentIdentifier=ENV_ID,
        ConfigurationProfileIdentifier=PROFILE_ID,
    )
    resp = _appconfigdata.get_latest_configuration(
        ConfigurationToken=session["InitialConfigurationToken"]
    )
    data = resp["Configuration"].read()
    return json.loads(data)


def _rank(models: list, weights: dict) -> list:
    q = weights["quality"] / 100.0
    c = weights["cost"] / 100.0
    l = weights["latency"] / 100.0
    ranked = []
    for m in models:
        score = q * m["quality"] + c * m["cost"] + l * m["latency"]
        ranked.append(
            {
                "id": m["id"],
                "name": m["name"],
                "quality": m["quality"],
                "cost": m["cost"],
                "latency": m["latency"],
                "score": round(score, 4),
            }
        )
    ranked.sort(key=lambda x: x["score"], reverse=True)
    return ranked


def _deploy_new_version(config: dict) -> None:
    version = _appconfig.create_hosted_configuration_version(
        ApplicationId=APP_ID,
        ConfigurationProfileId=PROFILE_ID,
        ContentType="application/json",
        Content=json.dumps(config).encode("utf-8"),
    )
    _appconfig.start_deployment(
        ApplicationId=APP_ID,
        EnvironmentId=ENV_ID,
        ConfigurationProfileId=PROFILE_ID,
        DeploymentStrategyId=STRATEGY_ID,
        ConfigurationVersion=str(version["VersionNumber"]),
    )


def _response(config: dict) -> dict:
    ranked = _rank(config["models"], config["weights"])
    return {
        "weights": config["weights"],
        "selectedModelId": config["selectedModelId"],
        "selectedModelName": next(
            (m["name"] for m in config["models"] if m["id"] == config["selectedModelId"]),
            config["selectedModelId"],
        ),
        "ranking": ranked,
    }


def handler(event, context):
    method = (event.get("requestContext", {}).get("http", {}) or {}).get("method", "GET")
    if method == "OPTIONS":
        return {"statusCode": 200, "headers": _cors(), "body": "{}"}

    try:
        config = _load_config()
    except Exception as exc:  # noqa: BLE001
        return {"statusCode": 500, "headers": _cors(), "body": json.dumps({"error": f"config load failed: {exc}"})}

    if method == "GET":
        return {"statusCode": 200, "headers": _cors(), "body": json.dumps(_response(config))}

    # POST: update weights.
    try:
        body = json.loads(event.get("body") or "{}")
    except Exception:  # noqa: BLE001
        body = {}
    try:
        quality = int(round(float(body.get("quality"))))
        cost = int(round(float(body.get("cost"))))
        latency = int(round(float(body.get("latency"))))
    except (TypeError, ValueError):
        return {"statusCode": 400, "headers": _cors(), "body": json.dumps({"error": "quality, cost, latency required"})}

    if quality + cost + latency != 100:
        return {
            "statusCode": 400,
            "headers": _cors(),
            "body": json.dumps({"error": f"weights must sum to 100 (got {quality + cost + latency})"}),
        }
    if min(quality, cost, latency) < 0:
        return {"statusCode": 400, "headers": _cors(), "body": json.dumps({"error": "weights must be non-negative"})}

    config["weights"] = {"quality": quality, "cost": cost, "latency": latency}
    ranked = _rank(config["models"], config["weights"])
    new_selected = ranked[0]["id"]
    changed = new_selected != config.get("selectedModelId")
    config["selectedModelId"] = new_selected

    try:
        _deploy_new_version(config)
    except Exception as exc:  # noqa: BLE001
        return {"statusCode": 500, "headers": _cors(), "body": json.dumps({"error": f"deploy failed: {exc}"})}

    out = _response(config)
    out["changed"] = changed
    return {"statusCode": 200, "headers": _cors(), "body": json.dumps(out)}
