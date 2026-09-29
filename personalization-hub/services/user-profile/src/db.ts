import { Pool } from "pg";

export interface UserRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  is_admin: boolean;
  created_at: string;
}

let pool: Pool | null = null;

function databaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const user = process.env.DB_USER;
  const pass = process.env.DB_PASS;
  const host = process.env.DB_HOST;
  const port = process.env.DB_PORT || "5432";
  const name = process.env.DB_NAME || "personalize";
  return `postgresql://${user}:${pass}@${host}:${port}/${name}`;
}

export function getPool(): Pool {
  if (!pool) {
    // RDS requires TLS. The AWS RDS CA is not bundled in the image, so we
    // enable SSL without full chain verification (acceptable within the VPC).
    pool = new Pool({
      connectionString: databaseUrl(),
      ssl: { rejectUnauthorized: false },
    });
  }
  return pool;
}

export async function initSchema(): Promise<void> {
  const p = getPool();
  await p.query("CREATE EXTENSION IF NOT EXISTS pgcrypto;");
  await p.query(`
    CREATE TABLE IF NOT EXISTS app_user (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      is_admin BOOLEAN NOT NULL DEFAULT false,
      preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

export class DuplicateEmailError extends Error {}

export async function createUser(
  email: string,
  displayName: string,
  passwordHash: string
): Promise<UserRow> {
  const p = getPool();
  try {
    const res = await p.query(
      `INSERT INTO app_user (email, display_name, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, email, display_name, password_hash, is_admin, created_at`,
      [email, displayName, passwordHash]
    );
    return res.rows[0];
  } catch (err: any) {
    if (err && err.code === "23505") {
      throw new DuplicateEmailError("email already registered");
    }
    throw err;
  }
}

export async function findByEmail(email: string): Promise<UserRow | null> {
  const p = getPool();
  const res = await p.query(
    `SELECT id, email, display_name, password_hash, is_admin, created_at
     FROM app_user WHERE email = $1`,
    [email]
  );
  return res.rows[0] ?? null;
}

export async function findById(id: string): Promise<UserRow | null> {
  const p = getPool();
  const res = await p.query(
    `SELECT id, email, display_name, password_hash, is_admin, created_at
     FROM app_user WHERE id = $1`,
    [id]
  );
  return res.rows[0] ?? null;
}

export async function updateProfile(
  id: string,
  displayName: string | undefined,
  preferences: object | undefined
): Promise<UserRow | null> {
  const p = getPool();
  const res = await p.query(
    `UPDATE app_user
       SET display_name = COALESCE($2, display_name),
           preferences  = COALESCE($3, preferences)
     WHERE id = $1
     RETURNING id, email, display_name, password_hash, is_admin, created_at`,
    [id, displayName ?? null, preferences ? JSON.stringify(preferences) : null]
  );
  return res.rows[0] ?? null;
}
