import argon2 from "argon2";
import jwt from "jsonwebtoken";

export interface TokenClaims {
  sub: string;
  admin: boolean;
}

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

export function signToken(userId: string, isAdmin: boolean): string {
  const secret = process.env.JWT_SECRET as string;
  return jwt.sign({ sub: userId, admin: isAdmin }, secret, {
    algorithm: "HS256",
    expiresIn: "12h",
  });
}

export function verifyToken(token: string): TokenClaims | null {
  try {
    const secret = process.env.JWT_SECRET as string;
    const payload = jwt.verify(token, secret) as jwt.JwtPayload;
    if (!payload.sub) return null;
    return { sub: String(payload.sub), admin: Boolean(payload.admin) };
  } catch {
    return null;
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email);
}
