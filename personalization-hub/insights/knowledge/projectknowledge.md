# Project Knowledge: Personalization Hub + Insights App

_Last updated by the deployment agent. This document is the grounding knowledge base for the Insights Assistant chatbot. It contains design and deployment information only — no secrets, credentials, API keys, or connection strings._

## Class context

This deployment is a teaching example for a **"Generative AI Development on AWS"** class whose students work at GoTo. The instructor orchestrated the deployment via an AI coding agent (Kiro). Two applications exist:

1. **Personalization Hub** — the original content-recommendation application, now enhanced with a Generative AI component.
2. **Insights App** — this companion application, which explains the deployment and exposes live LLM reasoning logs.

## Application 1: Personalization Hub

### Purpose
A "content hub" / mini GoTo Learning Center where authenticated users log in and see personalized recommendations for content items (articles, videos, internal docs).

### Public URL
`https://personalize.awsteach.com` (HTTPS via CloudFront; HTTP redirects to HTTPS).

### Architecture
- **Frontend:** Next.js server-side-rendered (SSR) app running on ECS/Fargate (not a static export — SSR runs on AWS).
- **Backend microservices (ECS/Fargate):**
  - **User Profile Service** (Node.js / Express / TypeScript): registration, login, JWT sessions, profile management. Passwords hashed with argon2.
  - **Recommendation Service** (Python / FastAPI): produces ranked recommendations, applies the feature flag and A/B assignment, records impressions, serves ML inference, and generates LLM explanations.
- **Data:** Amazon RDS PostgreSQL (Multi-AZ) for users, items, interactions, feature flags, and experiment assignments. Amazon S3 for ML model artifacts and training-data snapshots.
- **Edge:** Amazon CloudFront distribution in front of an Application Load Balancer (ALB). Route 53 ALIAS records for the domain. ACM certificates: one in us-east-1 for CloudFront, one in us-east-2 for the ALB.
- **Region:** us-east-2 (the CloudFront certificate is in us-east-1 because CloudFront requires it there).
- **IaC:** AWS CDK (TypeScript), deployed as multiple stacks (Network, Data, Certificate, Services, Edge, Training, Observability).

### Recommendation strategies (feature-flagged)
The recommendation strategy is controlled by a feature flag (`recommendation_strategy`) stored in RDS, with a rollout percent driving an A/B test. Assignment is deterministic and sticky per user (a stable hash of the user id), and experiment assignments are stored idempotently in RDS.

- **rule-based** (A/B control): ranks items by a blend of popularity and recency.
- **ml-based:** collaborative filtering using an implicit-feedback ALS (Alternating Least Squares) model trained offline.
- **llm-enhanced** (A/B treatment): starts from the ML ranking, then uses **Amazon Bedrock (Claude Haiku 4.5 via an inference profile)** to generate a short, personalized natural-language explanation for each recommended item, grounded in the user's recent activity. Cold-start users (unknown to the ML model) fall back to rule-based ranking.

### The Generative AI component (the LLM enhancement)
- The Recommendation Service calls Bedrock's **Converse API** with a system prompt that instructs the model to write a single friendly sentence explaining why an item is a good next step, referencing the learner's history, without inventing facts.
- Model: `us.anthropic.claude-haiku-4-5-20251001-v1:0` (an inference profile; on-demand invocation of the base model id is not supported in this account).
- **Reasoning logging:** every LLM prompt and response (system prompt, user prompt, response, latency, token counts) is written to a dedicated CloudWatch log group: `/personalization-hub/llm-reasoning`. LLM failures fall back gracefully to the base ranking and are also logged. No secrets are logged.

### Machine learning (offline)
- A scheduled Fargate task (nightly, via EventBridge) trains the ALS model: it snapshots interactions from RDS to S3, builds the implicit-feedback matrix, trains with NumPy, evaluates recall@k, and publishes a versioned model artifact plus a `models/latest.json` metadata file to S3. If training fails, the previous artifact is left intact.
- The Recommendation Service lazily loads the latest model from S3 and caches it in memory, reloading when a newer version appears. An admin endpoint can force a reload.

### Enterprise features demonstrated
- **Microservices:** separate recommendation and user-profile services, plus the SSR frontend, each independently deployable on Fargate.
- **Feature flags:** toggle strategy and rollout percent at runtime (no redeploy).
- **A/B testing:** sticky variant assignment stored in RDS; a CTR-by-variant metrics query compares variants.
- **CI/CD:** GitHub Actions workflow runs unit and property-based tests, builds container images, pushes to ECR (tagged by commit SHA), and runs `cdk deploy`. ECS uses a deployment circuit breaker with automatic rollback, gated by ALB `/healthz` health checks. AWS access uses OIDC role assumption (no long-lived keys).
- **Observability:** CloudWatch logs, metrics, alarms (ALB 5xx, target health, RDS CPU/connections), and a dashboard.
- **Security:** DB credentials and the JWT signing key are stored in AWS Secrets Manager and injected at runtime — never baked into images or source. Services and RDS run in private/isolated subnets. Admin endpoints require an admin claim in the JWT. HTTPS end-to-end.

### API surface (Personalization Hub)
- `POST /api/users/register`, `POST /api/users/login` — auth (User Profile Service).
- `GET /api/profile`, `PATCH /api/profile` — profile (User Profile Service).
- `GET /api/recommendations?limit=N` — ranked recommendations (Recommendation Service).
- `POST /api/interactions` — record a view/click/complete event.
- `GET /api/items` — list content items.
- `GET /api/experiments/metrics` — CTR by A/B variant (admin only).
- `PUT /api/flags/recommendation_strategy` — toggle the feature flag (admin only).
- `POST /admin/model/reload` — reload the latest ML model (admin only).
- `GET /api/healthz`, `GET /healthz` — health checks used by the ALB.

## Application 2: Insights App (this app)

### Purpose
Give students insight into everything deployed for the class, and keep it updated as new functionality is added.

### Architecture (fully serverless)
- **Static frontend** (HTML/CSS/JS) stored in **Amazon S3** and served publicly.
- **Dynamic content** via **AWS Lambda** functions behind an HTTP API (API Gateway):
  - **Chatbot Lambda:** answers student questions using **Amazon Bedrock (Claude Haiku 4.5)**, grounded in this `projectknowledge.md` file (read from S3). It can also fetch and summarize recent LLM reasoning logs when asked. Its own prompts/responses are logged to `/personalization-hub/chatbot-reasoning`.
  - **Logs Lambda:** returns recent LLM reasoning records (from both `/personalization-hub/llm-reasoning` and `/personalization-hub/chatbot-reasoning`) as structured JSON for the UI to render. Sensitive-looking fields are redacted defensively.
- **Knowledge base:** `projectknowledge.md` in S3, kept updated by the deployment agent.

### How the chatbot works
The chatbot loads this knowledge base as grounding context in the system prompt and instructs the model to answer only from it, to say so when something is not covered, and never to reveal secrets. When a question mentions logs/prompts/reasoning/traces, the chatbot also pulls recent reasoning-log records and passes them to the model as additional context.

### Reasoning-log transparency
Both applications write their LLM prompts and responses to CloudWatch. The Insights App surfaces these so students can see exactly what prompts were sent and what the model returned, including latency and token usage — a concrete look at GenAI observability. No secrets appear in these logs.

### Link from the main app
The Personalization Hub home page includes a link to this Insights App so students can jump straight to it.

## Notes and honest caveats
- The original Personalization Hub, as first deployed, used only classical ML (ALS) and rule-based scoring — no LLM. The `llm-enhanced` strategy was added specifically to demonstrate Generative AI on AWS, which is the focus of the class.
- Costs to be aware of in this demo: RDS Multi-AZ, the NAT gateway, CloudFront, Fargate tasks, and per-call Bedrock usage. The whole deployment can be torn down with `cdk destroy --all`.

## Dynamic Bedrock model selection (AppConfig-driven)

To demonstrate Bedrock's flexibility in swapping the underlying LLM without redeploying, the Personalization Hub includes a model-preference control:

- **Five candidate models** with normalized strengths (quality / cost / latency, each 0–1):
  - Claude Opus 4.5 — quality 1.0, cost 0.15, latency 0.30 (highest quality, slowest/most expensive)
  - Claude Sonnet 4.5 — quality 0.85, cost 0.55, latency 0.65 (balanced)
  - Claude Haiku 4.5 — quality 0.65, cost 0.90, latency 0.95 (fast, cheap)
  - Amazon Nova Pro — quality 0.70, cost 0.80, latency 0.80 (balanced, economical)
  - Amazon Nova Lite — quality 0.45, cost 1.00, latency 1.00 (cheapest, fastest)
- **AWS AppConfig** stores the preference weights (starting at quality 50%, cost 25%, latency 25%), the model catalog, and the currently selected model id. AppConfig is the source of truth.
- **Frontend control:** the main app home page has three linked slider bars (quality/cost/latency) that always sum to 100%, an "Apply preferences" button, and a live ranking of all five models for the current weights (the live model is marked).
- **Model-selector Lambda** (behind its own API Gateway HTTP API): on apply, it validates the weights sum to 100, ranks the models by `score = quality_w·Q + cost_w·C + latency_w·L`, writes the winner to AppConfig (new hosted configuration version + instant deployment), and returns the ranking.
- **Live switch:** the recommendation service reads the selected model id from AppConfig (via the AppConfig Data API, cached ~30s) and uses it for the next inference. No container redeploy is needed — changing the sliders changes which Bedrock model generates recommendation explanations within seconds.
- **Verified behavior:** quality=100 selects Claude Opus 4.5; cost=100 selects Amazon Nova Lite; the default 50/25/25 selects Claude Haiku 4.5. The reasoning logs record which model produced each explanation, so the switch is observable.
