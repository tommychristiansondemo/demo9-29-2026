import type { NextApiRequest, NextApiResponse } from "next";
import { INTERNAL_API } from "../../lib/api";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();
  const { email, password, displayName, mode } = req.body ?? {};
  const path = mode === "register" ? "/api/users/register" : "/api/users/login";
  const name = (displayName && String(displayName).trim()) || email?.split("@")[0];
  const body = mode === "register" ? { email, password, displayName: name } : { email, password };
  const upstream = await fetch(`${INTERNAL_API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok) {
    return res.status(upstream.status).json(data);
  }
  // Store JWT in an HTTP-only cookie.
  res.setHeader(
    "Set-Cookie",
    `auth_token=${data.token}; HttpOnly; Path=/; Max-Age=43200; SameSite=Lax`
  );
  return res.status(200).json({ user: data.user });
}
