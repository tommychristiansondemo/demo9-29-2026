import { describe, it, expect, beforeAll } from "vitest";
import fc from "fast-check";
import {
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
  isValidEmail,
} from "../src/auth";

beforeAll(() => {
  process.env.JWT_SECRET = "test-secret-for-unit-tests";
});

describe("password hashing", () => {
  it("verifies a correct password and rejects a wrong one (property)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 40 }),
        fc.string({ minLength: 1, maxLength: 40 }),
        async (pw, other) => {
          const hash = await hashPassword(pw);
          expect(await verifyPassword(hash, pw)).toBe(true);
          if (pw !== other) {
            expect(await verifyPassword(hash, other)).toBe(false);
          }
        }
      ),
      { numRuns: 15 }
    );
  });

  it("never stores the plaintext password in the hash", async () => {
    const hash = await hashPassword("hunter2");
    expect(hash.includes("hunter2")).toBe(false);
  });
});

describe("JWT issue/verify", () => {
  it("round-trips claims (property)", () => {
    fc.assert(
      fc.property(fc.uuid(), fc.boolean(), (userId, admin) => {
        const token = signToken(userId, admin);
        const claims = verifyToken(token);
        expect(claims).not.toBeNull();
        expect(claims!.sub).toBe(userId);
        expect(claims!.admin).toBe(admin);
      })
    );
  });

  it("rejects a tampered/invalid token", () => {
    expect(verifyToken("not.a.token")).toBeNull();
    const token = signToken("u1", false);
    expect(verifyToken(token + "x")).toBeNull();
  });
});

describe("email validation", () => {
  it("accepts well-formed emails and rejects malformed ones", () => {
    expect(isValidEmail("a@b.com")).toBe(true);
    expect(isValidEmail("no-at-sign")).toBe(false);
    expect(isValidEmail("a@b")).toBe(false);
  });
});
