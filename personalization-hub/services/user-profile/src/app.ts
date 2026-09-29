import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import {
  hashPassword,
  isValidEmail,
  signToken,
  verifyPassword,
  verifyToken,
} from "./auth";
import {
  DuplicateEmailError,
  UserRow,
  createUser,
  findByEmail,
  findById,
  updateProfile,
} from "./db";

const VERSION = process.env.APP_VERSION || "dev";

function publicUser(u: UserRow) {
  return {
    id: u.id,
    email: u.email,
    displayName: u.display_name,
    isAdmin: u.is_admin,
    createdAt: u.created_at,
  };
}

interface AuthedRequest extends Request {
  userId?: string;
  isAdmin?: boolean;
}

function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const bearer = header && header.toLowerCase().startsWith("bearer ") ? header.slice(7) : undefined;
  const token = bearer || req.cookies?.auth_token;
  const claims = token ? verifyToken(token) : null;
  if (!claims) {
    return res.status(401).json({ error: "unauthorized" });
  }
  req.userId = claims.sub;
  req.isAdmin = claims.admin;
  next();
}

export function createApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());

  app.get("/healthz", (_req, res) => res.json({ status: "ok", version: VERSION }));

  app.post("/api/users/register", async (req, res) => {
    const { email, password, displayName } = req.body ?? {};
    if (!email || !isValidEmail(email) || !password || !displayName) {
      return res.status(400).json({ error: "invalid input" });
    }
    if (String(displayName).length < 1 || String(displayName).length > 100) {
      return res.status(400).json({ error: "invalid displayName" });
    }
    try {
      const hash = await hashPassword(password);
      const user = await createUser(email, displayName, hash);
      const token = signToken(user.id, user.is_admin);
      return res.status(201).json({ token, user: publicUser(user) });
    } catch (err) {
      if (err instanceof DuplicateEmailError) {
        return res.status(409).json({ error: "email already registered" });
      }
      throw err;
    }
  });

  app.post("/api/users/login", async (req, res) => {
    const { email, password } = req.body ?? {};
    // Generic 401 that does not reveal which field was wrong.
    const invalid = () => res.status(401).json({ error: "invalid credentials" });
    if (!email || !password) return invalid();
    const user = await findByEmail(email);
    if (!user) return invalid();
    const ok = await verifyPassword(user.password_hash, password);
    if (!ok) return invalid();
    const token = signToken(user.id, user.is_admin);
    return res.json({ token, user: publicUser(user) });
  });

  app.get("/api/profile", requireAuth, async (req: AuthedRequest, res) => {
    const user = await findById(req.userId!);
    if (!user) return res.status(404).json({ error: "not found" });
    return res.json({ user: publicUser(user) });
  });

  app.patch("/api/profile", requireAuth, async (req: AuthedRequest, res) => {
    const { displayName, preferences } = req.body ?? {};
    if (displayName !== undefined && (String(displayName).length < 1 || String(displayName).length > 100)) {
      return res.status(400).json({ error: "invalid displayName" });
    }
    const user = await updateProfile(req.userId!, displayName, preferences);
    if (!user) return res.status(404).json({ error: "not found" });
    return res.json({ user: publicUser(user) });
  });

  return app;
}
