"""JWT verification shared with the user-profile service (same signing secret)."""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Optional

import jwt


@dataclass
class Claims:
    user_id: str
    is_admin: bool


def _secret() -> str:
    return os.environ["JWT_SECRET"]


def verify(token: str) -> Optional[Claims]:
    try:
        payload = jwt.decode(token, _secret(), algorithms=["HS256"])
    except jwt.PyJWTError:
        return None
    sub = payload.get("sub")
    if not sub:
        return None
    return Claims(user_id=str(sub), is_admin=bool(payload.get("admin", False)))


def extract_token(authorization: Optional[str], cookie: Optional[str]) -> Optional[str]:
    if authorization and authorization.lower().startswith("bearer "):
        return authorization[7:]
    if cookie:
        return cookie
    return None
