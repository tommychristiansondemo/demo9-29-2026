"""Seed sample content, users, and interactions for the demo.

Run as a one-off task: python -m rec.seed
Idempotent-ish: skips seeding items if items already exist.
"""
from __future__ import annotations

import random

from . import db


ITEMS = [
    ("Getting Started with GoTo Connect", "article", ["onboarding", "voip"], 0.9),
    ("Intro to Machine Learning Engineering", "video", ["ml", "training"], 0.95),
    ("Deploying to AWS Fargate", "doc", ["aws", "devops"], 0.85),
    ("Feature Flags in Practice", "article", ["engineering", "flags"], 0.8),
    ("A/B Testing 101", "video", ["experimentation", "metrics"], 0.88),
    ("Collaborative Filtering Explained", "article", ["ml", "recsys"], 0.92),
    ("Securing Microservices", "doc", ["security", "architecture"], 0.75),
    ("CI/CD with GitHub Actions", "video", ["devops", "cicd"], 0.82),
    ("PostgreSQL Performance Tuning", "article", ["database", "performance"], 0.7),
    ("Observability with CloudWatch", "doc", ["aws", "monitoring"], 0.78),
    ("Building SSR Apps with Next.js", "video", ["frontend", "nextjs"], 0.83),
    ("Implicit Feedback Recommenders", "article", ["ml", "recsys"], 0.9),
]


def main():
    conn = db.connect()
    db.init_schema(conn)

    existing = db.list_items(conn)
    if existing:
        print(f"items already present ({len(existing)}); skipping item seed")
        item_ids = [i["id"] for i in existing]
    else:
        item_ids = [
            db.create_item(conn, title, t, f"https://learn.awsteach.com/{i}", tags, pop)
            for i, (title, t, tags, pop) in enumerate(ITEMS)
        ]
        print(f"seeded {len(item_ids)} items")

    # Create some demo users with interactions to give the ALS model signal.
    rng = random.Random(42)
    with conn.cursor() as cur:
        for u in range(8):
            email = f"learner{u}@awsteach.com"
            cur.execute(
                """INSERT INTO app_user (email, display_name, password_hash)
                   VALUES (%s,%s,%s)
                   ON CONFLICT (email) DO NOTHING
                   RETURNING id""",
                (email, f"Learner {u}", "seed-not-loginable"),
            )
            row = cur.fetchone()
            if row is None:
                cur.execute("SELECT id FROM app_user WHERE email=%s", (email,))
                row = cur.fetchone()
            user_id = str(row["id"])
            # Each user interacts with a themed subset for collaborative signal.
            liked = rng.sample(item_ids, k=rng.randint(3, 6))
            for item_id in liked:
                for event in ("view", "click", "complete"):
                    if event == "complete" and rng.random() < 0.5:
                        continue
                    db.record_interaction(conn, user_id, item_id, event)
    print("seeded demo users and interactions")
    conn.close()


if __name__ == "__main__":
    main()
