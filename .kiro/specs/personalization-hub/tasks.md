# Implementation Plan

## Overview

This plan builds the Personalization Hub incrementally: shared domain logic and its property-based tests first, then the two microservices, the ML training/inference path, the frontend, the AWS CDK infrastructure, CI/CD, and finally end-to-end deployment verification. Each task references the requirements it implements. Correctness properties from the design are validated via property-based tests (hypothesis for Python, fast-check for TypeScript).

## Task Dependency Graph

```mermaid
graph TD
    T1[1. Repo & workspace scaffolding] --> T2[2. Shared domain: recommendation logic]
    T1 --> T3[3. Recommendation Service API]
    T2 --> T3
    T1 --> T4[4. User Profile Service]
    T2 --> T5[5. ML training job + inference]
    T3 --> T5
    T1 --> T6[6. Next.js SSR frontend]
    T3 --> T6
    T4 --> T6
    T1 --> T7[7. CDK: network + data stacks]
    T7 --> T8[8. CDK: certificate + services stacks]
    T8 --> T9[9. CDK: edge (CloudFront + Route53) + training + observability]
    T3 --> T10[10. Containerization]
    T4 --> T10
    T5 --> T10
    T6 --> T10
    T10 --> T11[11. CI/CD pipeline]
    T9 --> T11
    T9 --> T12[12. Deploy & end-to-end verification]
    T11 --> T12
```

```json
{
  "waves": [
    { "wave": 1, "tasks": ["1"] },
    { "wave": 2, "tasks": ["2", "4", "6", "7"] },
    { "wave": 3, "tasks": ["3", "8"] },
    { "wave": 4, "tasks": ["5", "9", "10"] },
    { "wave": 5, "tasks": ["11"] },
    { "wave": 6, "tasks": ["12"] }
  ]
}
```

## Tasks

- [x] 1. Set up monorepo workspace scaffolding and shared configuration
  - Create workspace structure: `services/recommendation` (Python), `services/user-profile` (Node/TS), `frontend` (Next.js), `training` (Python), `infra` (CDK TS), and a shared `packages/` area for common types.
  - Add Python tooling (pyproject/poetry or requirements + pytest + hypothesis) and Node tooling (package.json + tsconfig + vitest/jest + fast-check).
  - Add a root README describing local dev and the AWS-only runtime guarantee.
  - _Requirements: 8.1, 8.2_

- [x] 2. Implement shared recommendation domain logic with property-based tests
- [x] 2.1 Implement core types and pure functions in the recommendation service
  - Define `RecommendedItem`, `RecommendationResponse`, `InteractionEvent`, `Strategy`, and `FeatureFlag` types.
  - Implement `resolve_strategy(user_id, flag)` with deterministic, sticky bucketing (stable hash mod 100 vs rollout_percent).
  - Implement `score_items_rule_based(candidates)` (popularity + recency) and the ranking/dedup/limit helper (`rank_and_take`).
  - _Requirements: 3.1, 3.2, 3.3, 4.1, 4.2, 4.3_
- [x] 2.2 Implement ML scoring function
  - Implement `score_items_ml(user_id, candidates, model)` returning finite scores, deterministic order, cold-start empty result when the user is unknown.
  - _Requirements: 3.5, 3.6, 7.4_
- [x] 2.3 Write property-based tests for the recommendation domain (hypothesis)
  - Property 1 cardinality, Property 2 distinctness, Property 3 ordering (Req 3.1–3.3).
  - Property 5 sticky assignment, Property 7 flag-off (Req 4.1–4.2), Property 6 rollout proportionality (Req 5.1).
  - Property 8 finite scores (Req 3.5), Property 9 cold-start fallback (Req 3.6).
  - _Requirements: 3.1, 3.2, 3.3, 3.5, 3.6, 4.1, 4.2, 5.1_

- [x] 3. Build the Recommendation Service (Python / FastAPI)
- [x] 3.1 Implement the database layer and schema
  - Create migrations/DDL for `item`, `interaction`, `feature_flag`, `experiment_assignment` (with unique constraint on `(experiment_key, user_id)`).
  - Implement repositories: candidate item query (excluding completed items), interaction insert with weight mapping, feature-flag read/update, experiment-assignment idempotent upsert.
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 3.4, 4.3, 4.4, 5.3_
- [x] 3.2 Implement `get_recommendations` orchestration and endpoints
  - Wire `GET /api/recommendations`, `POST /api/interactions`, `GET /api/experiments/metrics` (admin), `POST /admin/model/reload` (admin), and `GET /healthz`.
  - Record impressions and idempotent experiment assignments; enforce admin JWT claim on admin routes.
  - Implement the CTR-by-variant metrics query.
  - _Requirements: 3.1, 3.4, 3.7, 5.2, 5.4, 8.3, 8.4, 12.3_
- [x] 3.3 Write integration tests against a containerized Postgres
  - Verify end-to-end recommendation + interaction logging, idempotent assignment (Property 10 / Req 5.2), and completed-item exclusion.
  - _Requirements: 2.5, 3.4, 5.2, 5.3_

- [x] 4. Build the User Profile Service (Node / Express / TypeScript)
- [x] 4.1 Implement user schema, registration, and login
  - Create `user` table/migration; implement register (hash with bcrypt/argon2, reject duplicate email) and login (verify hash, sign JWT, generic 401 on failure).
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.8_
- [x] 4.2 Implement profile endpoints and JWT middleware
  - `GET /api/profile`, `PATCH /api/profile` (never expose password hash), JWT verification middleware returning 401 on missing/malformed/expired tokens, and `GET /healthz`.
  - _Requirements: 1.5, 1.6, 1.7, 8.4, 12.3_
- [x] 4.3 Write unit and property-based tests (fast-check)
  - Test password hashing/verification round-trips, JWT issue/verify, duplicate-email rejection, and 401 secrecy (no email-vs-password disclosure).
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.7, 1.8_

- [x] 5. Implement ML training job and model inference loading
- [x] 5.1 Implement the offline ALS training job (Python)
  - Snapshot interactions from RDS to S3; build implicit-feedback matrix; train ALS; evaluate recall@k; write versioned artifact + metadata JSON to S3; leave prior artifact intact on failure.
  - Emit training success/failure metrics to CloudWatch.
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_
- [x] 5.2 Implement model cache + lazy reload in the recommendation service
  - Load latest artifact from S3, cache in memory, reload when a newer version appears, and support the admin reload endpoint; fall back to rule-based on load failure.
  - _Requirements: 3.8, 7.1, 7.2, 7.3_
- [x] 5.3 Write tests for training/inference boundaries
  - Test artifact versioning/metadata, corrupt-artifact fallback (Req 3.8), and finite-score guarantees on loaded models.
  - _Requirements: 3.5, 3.8, 6.3, 7.2_

- [x] 6. Build the Next.js SSR frontend
- [x] 6.1 Implement auth flow and pages
  - Login/register pages that call the user service; store JWT in an HTTP-only cookie; redirect to `/login` on 401.
  - _Requirements: 1.3, 1.7_
- [x] 6.2 Implement SSR home page and item detail with recommendations
  - `getServerSideProps` fetches recommendations server-side (runs on Fargate); render items with a teaching indicator for strategy/variant; post interaction events.
  - Add `/healthz` for ALB checks.
  - _Requirements: 2.3, 3.7, 8.2, 8.4_

- [x] 7. Implement CDK network and data infrastructure stacks
- [x] 7.1 Create the CDK app entry and network stack
  - Configure `bin/app.ts` for `us-east-2`; build a VPC with public + private subnets across 2 AZs, NAT, and security groups (ALB SG, service SG, RDS SG).
  - _Requirements: 9.1, 9.7_
- [x] 7.2 Create the data stack
  - Provision RDS PostgreSQL (Multi-AZ) in isolated subnets, S3 buckets for snapshots/artifacts, and Secrets Manager entries for DB creds and JWT signing key.
  - _Requirements: 9.7, 12.1, 12.2_

- [x] 8. Implement CDK certificate and services stacks
- [x] 8.1 Create the cross-region certificate stack
  - Provision the `us-east-1` ACM cert for CloudFront (crossRegionReferences) and the `us-east-2` ACM cert for the ALB, both DNS-validated against `awsteach.com`. Do not create any `www.awsteach.com` record.
  - _Requirements: 9.3, 9.5_
- [x] 8.2 Create the services stack (ECS + ALB + Fargate services)
  - ECS cluster, ALB with HTTPS listener (us-east-2 cert) and HTTP→HTTPS redirect, path routing to recommendation/user services, `/healthz` target groups, secrets injected as ECS secrets, least-privilege task roles, and deployment circuit breaker with rollback enabled.
  - _Requirements: 8.1, 8.3, 8.4, 9.4, 9.7, 10.4, 10.5, 12.1, 12.2, 12.4_

- [x] 9. Implement CDK edge, training, and observability stacks
- [x] 9.1 Create the edge stack (CloudFront + Route 53)
  - CloudFront distribution with ALB origin, `/api/*` no-cache behavior forwarding headers/cookies, static-asset caching, and a Route 53 ALIAS for `personalize.awsteach.com`. Confirm no `www.awsteach.com` record is touched.
  - _Requirements: 9.2, 9.4, 9.5, 12.4_
- [x] 9.2 Create the training and observability stacks
  - EventBridge schedule + Fargate task definition for training; CloudWatch log groups, metrics, alarms (ALB 5xx, target health, RDS CPU/connections, ECS task failures, model-load failures), and a dashboard (latency, strategy distribution, A/B CTR by variant).
  - _Requirements: 6.1, 11.1, 11.2, 11.3_

- [x] 10. Containerize all services
  - Write Dockerfiles for frontend, recommendation, user-profile, and training; ensure images are self-contained and reference runtime config via env/secrets (no local dependencies).
  - _Requirements: 9.6, 12.1_

- [x] 11. Implement CI/CD pipeline (GitHub Actions)
  - Workflow: run unit + property tests (fail fast) → build images → push to ECR (SHA tag) → `cdk deploy` updating task defs → rely on ECS circuit breaker + ALB `/healthz` for verification and rollback.
  - Configure AWS access via OIDC role assumption; store no long-lived keys.
  - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6_

- [x] 12. Deploy and verify end-to-end on AWS
  - Deploy all stacks in order (certificate → network → data → services → edge → training → observability) to `us-east-2`.
  - Seed sample users/items/interactions; trigger an initial training run to publish a model artifact.
  - Smoke test through CloudFront at `https://personalize.awsteach.com`: HTTPS redirect, login, SSR recommendations, interaction logging, feature-flag toggle, and A/B metrics — confirming the app runs fully on AWS with the local server off.
  - _Requirements: 9.1, 9.2, 9.4, 9.6, 4.4, 5.4, 7.1_

## Notes

- Tasks are ordered so shared, testable domain logic (Task 2) and its property-based tests land before the services that depend on it. The wave definitions above reflect which tasks can proceed in parallel once their prerequisites are met.
- Property-based tests directly encode the design's Correctness Properties: Properties 1–5, 7–9 are validated in Task 2.3 (recommendation domain), Property 6 (rollout proportionality) in Task 2.3, and Property 10 (idempotent assignment) in Task 3.3 via integration tests.
- Deployment (Task 12) requires the AWS credentials for the account hosting the `awsteach.com` hosted zone. No runtime component depends on the local server; after Task 12 succeeds, the local chat/build server can be turned off.
- The `www.awsteach.com` record is never created or modified (enforced in Tasks 8.1 and 9.1).
