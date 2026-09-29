# Requirements Document

## Introduction

Personalization Hub is an enterprise-quality content recommendation application built as a teaching example for a Machine Learning Engineering class delivered to GoTo Technologies employees. Authenticated users log into a mini "GoTo learning center" and see personalized recommendations for content items (articles, videos, internal docs). The system demonstrates modern ML engineering practices: a microservices backend, an offline-trained collaborative filtering model with online inference, feature flags to toggle recommendation strategies, A/B testing infrastructure, full observability, and a complete CI/CD pipeline.

The application is deployed entirely on AWS in region `us-east-2` and is fully self-hosted: after deployment, the local build/chat server can be turned off and the application continues to run with no local runtime dependency. The frontend is a server-side-rendered (SSR) Next.js app served through CloudFront; backend microservices run on ECS/Fargate behind an Application Load Balancer; PostgreSQL data lives in Amazon RDS; and S3 stores training-data snapshots and model artifacts. All infrastructure is defined as code with AWS CDK (TypeScript).

The application is served over HTTPS at `personalize.awsteach.com` using ACM certificates and Route 53 records in the existing `awsteach.com` hosted zone. The reserved name `www.awsteach.com` is never used.

These requirements are derived from the approved design document (`design.md`). The design's Correctness Properties reference specific acceptance criteria in this document (Requirements 3.1–3.6, 4.1–4.2, 5.1–5.2).

## Requirements

### Requirement 1: User Authentication and Profile Management

**User Story:** As a learner, I want to register, log in, and manage my profile, so that I can access a personalized content experience tied to my identity.

#### Acceptance Criteria

1. WHEN a user submits a registration request with a valid email, password, and display name THEN the User Profile Service SHALL create a new user with a hashed password and return an authentication token.
2. IF a registration request uses an email that already exists THEN the User Profile Service SHALL reject the request with a conflict error and SHALL NOT create a duplicate user.
3. WHEN a user submits valid login credentials THEN the User Profile Service SHALL verify the password against the stored hash and return a signed JWT.
4. IF login credentials are invalid THEN the User Profile Service SHALL respond with a 401 Unauthorized error and SHALL NOT reveal whether the email or the password was incorrect.
5. WHEN an authenticated user requests their profile THEN the User Profile Service SHALL return the profile without exposing the password hash.
6. WHEN an authenticated user submits a profile update with a valid display name or preferences THEN the User Profile Service SHALL persist the change and return the updated profile.
7. IF a request to a protected endpoint has a missing, malformed, or expired JWT THEN the service SHALL respond with 401 Unauthorized.
8. WHERE passwords are stored THE system SHALL hash them with a strong algorithm (bcrypt or argon2) and SHALL never log or return password values.

### Requirement 2: Content Items and Interactions

**User Story:** As a learner, I want the system to track the content items available and my interactions with them, so that recommendations can reflect what I engage with.

#### Acceptance Criteria

1. WHERE content is stored THE system SHALL represent each item with an id, title, type (article, video, or doc), tags, url, and a popularity score.
2. IF an item is created with a type outside the allowed enum (article, video, doc) THEN the system SHALL reject the item.
3. WHEN an authenticated user performs a view, click, or complete action on an item THEN the Recommendation Service SHALL record an interaction with the user id, item id, event type, and a positive implicit-feedback weight.
4. WHERE interaction weights are assigned THE system SHALL map event types to increasing weights (for example view < click < complete) and SHALL only store weights greater than zero.
5. WHEN interactions are recorded THEN the system SHALL persist them in RDS PostgreSQL so they are available for offline training and online candidate generation.

### Requirement 3: Recommendation Retrieval

**User Story:** As a learner, I want to receive a ranked list of relevant content on my home page, so that I can quickly find items worth my time.

#### Acceptance Criteria

1. WHEN an authenticated user requests recommendations with a limit N where 1 ≤ N ≤ 100 THEN the Recommendation Service SHALL return at most N items. *(Validates design Property 1: Recommendation cardinality.)*
2. WHEN recommendations are returned THEN the Recommendation Service SHALL ensure no item id appears more than once in the response. *(Validates design Property 2: Distinctness.)*
3. WHEN recommendations are returned THEN the Recommendation Service SHALL order items by score in non-increasing (descending) order. *(Validates design Property 3: Ordering.)*
4. WHEN recommendations are returned THEN every returned item id SHALL correspond to an existing item, and the system SHALL exclude items the user has already completed. *(Validates design Property 4: Validity.)*
5. WHEN the ML-based strategy scores items THEN every returned score SHALL be a finite real number with no NaN or infinite values. *(Validates design Property 5: Finite scores.)*
6. IF the requesting user is unknown to the current ML model (cold start) THEN the Recommendation Service SHALL fall back to rule-based recommendations while still satisfying the cardinality, distinctness, ordering, and validity criteria. *(Validates design Property 9: Cold-start fallback.)*
7. WHEN a recommendation response is produced THEN the Recommendation Service SHALL record an impression capturing the user, returned items, strategy, and experiment variant.
8. IF the model artifact is unavailable or corrupt THEN the Recommendation Service SHALL log the error and automatically serve rule-based recommendations instead of failing the request.

### Requirement 4: Feature Flags for Recommendation Strategy

**User Story:** As an ML engineer, I want to toggle between rule-based and ML-based recommendations via a feature flag, so that I can control strategy rollout without redeploying.

#### Acceptance Criteria

1. WHEN the recommendation strategy flag is enabled THEN the Recommendation Service SHALL resolve a deterministic and sticky strategy for a given user, such that repeated evaluations for the same user and flag yield the same strategy and variant. *(Validates design Property 6: Sticky assignment.)*
2. IF the recommendation strategy flag is disabled THEN the Recommendation Service SHALL return the flag's default variant for all users and SHALL NOT create any experiment assignment. *(Validates design Property 7: Flag off.)*
3. WHERE the feature flag is defined THE system SHALL store a master enabled toggle, a default variant, and a rollout percent constrained to the range 0–100.
4. WHEN an administrator updates the feature flag's enabled state or rollout percent at runtime THEN the change SHALL take effect for subsequent recommendation requests without requiring a redeploy.

### Requirement 5: A/B Testing and Experiment Metrics

**User Story:** As an ML engineer, I want users assigned to experiment variants and their outcomes measured, so that I can compare rule-based versus ML-based recommendations with real metrics.

#### Acceptance Criteria

1. WHEN the strategy flag is enabled with a given rollout percent THEN, over a large user population, the fraction of users assigned to the treatment (ML-based) variant SHALL approximate rollout_percent / 100. *(Validates design Property 10: Rollout proportionality.)*
2. WHEN an experiment assignment is recorded for a user THEN the system SHALL ensure the assignment is idempotent, such that recording the same (experiment_key, user_id) more than once does not create a duplicate row. *(Validates design Property 8: Idempotent assignment.)*
3. WHERE experiment assignments are stored THE system SHALL persist them in RDS with a unique constraint on (experiment_key, user_id) so assignments remain sticky per user.
4. WHEN an administrator requests experiment metrics THEN the system SHALL return click-through rate grouped by variant, computed from recorded interactions and assignments.

### Requirement 6: Offline Model Training

**User Story:** As an ML engineer, I want a scheduled offline training job that learns from interaction history, so that recommendations improve over time using collaborative filtering.

#### Acceptance Criteria

1. WHEN the training schedule triggers THEN a Fargate training task SHALL snapshot interaction data from RDS to S3 before training.
2. WHEN training runs THEN the job SHALL train an implicit-feedback collaborative filtering (ALS) model and evaluate holdout metrics such as recall@k.
3. WHEN training completes successfully THEN the job SHALL write a versioned model artifact and a metadata JSON (version, algorithm, trained-at, metrics) to S3.
4. WHEN training runs THEN the job SHALL emit success or failure metrics to CloudWatch.
5. IF training fails THEN the job SHALL leave the previously published model artifact intact so online inference is unaffected.

### Requirement 7: Online Inference and Model Loading

**User Story:** As a learner, I want fresh recommendations served quickly, so that my home page reflects the latest trained model without noticeable delay.

#### Acceptance Criteria

1. WHEN the Recommendation Service serves ML-based recommendations THEN it SHALL load the latest model artifact from S3 and cache it in memory.
2. WHEN a newer model version appears in S3 THEN the Recommendation Service SHALL reload the model on a subsequent request rather than requiring a restart.
3. WHEN an administrator invokes the model reload endpoint THEN the Recommendation Service SHALL load the latest artifact and return its metadata.
4. WHERE ML scoring occurs THE service SHALL bound scoring to a candidate set so online inference cost scales with the number of candidates and latent factors.

### Requirement 8: Microservices Architecture

**User Story:** As an architect, I want the backend split into distinct services, so that the system demonstrates enterprise microservice boundaries and independent deployability.

#### Acceptance Criteria

1. WHERE the backend is deployed THE system SHALL run a separate Recommendation Service and User Profile Service as independent Fargate services.
2. WHERE the frontend is deployed THE system SHALL run the Next.js SSR application as its own Fargate service rather than as a static export.
3. WHEN requests arrive at the ALB THEN the ALB SHALL path-route `/api/recommendations/*` and `/api/interactions/*` to the Recommendation Service and `/api/users/*` and `/api/profile/*` to the User Profile Service.
4. WHERE each service is deployed THE service SHALL expose a `/healthz` endpoint used by ALB target-group health checks.

### Requirement 9: Public Accessibility and Infrastructure

**User Story:** As a class attendee, I want to reach the application over the public internet at a friendly HTTPS URL, so that I can use it from any browser.

#### Acceptance Criteria

1. WHEN the application is deployed THEN all infrastructure SHALL be provisioned in AWS region `us-east-2` except for resources that must reside elsewhere (the CloudFront ACM certificate in `us-east-1`).
2. WHEN a user navigates to `https://personalize.awsteach.com` THEN Route 53 SHALL resolve the name via an ALIAS record to the CloudFront distribution.
3. WHERE HTTPS is served THE system SHALL use an ACM certificate in `us-east-1` for CloudFront and a separate ACM certificate in `us-east-2` for the ALB, both DNS-validated against the `awsteach.com` hosted zone.
4. WHEN a request arrives over HTTP THEN the system SHALL redirect it to HTTPS.
5. THE system SHALL NOT create, modify, or use any record for `www.awsteach.com`.
6. WHERE the application runs THE system SHALL host every runtime component (SSR frontend, APIs, database, model store, training, DNS, CDN) on AWS-managed resources, such that the local build/chat server can be turned off with no impact on the running application.
7. WHERE networking is configured THE system SHALL place Fargate services and RDS in private subnets, expose only the ALB and CloudFront publicly, and restrict RDS access to the service security group.

### Requirement 10: CI/CD with Health Checks and Rollback

**User Story:** As a platform engineer, I want automated deployments with health verification and automatic rollback, so that bad releases do not take down the service.

#### Acceptance Criteria

1. WHEN code is pushed to the main branch THEN GitHub Actions SHALL run unit and property-based tests and fail fast on test failure.
2. WHEN tests pass THEN the pipeline SHALL build container images for the frontend, recommendation, user-profile, and training components and push them to ECR tagged by commit SHA.
3. WHEN images are pushed THEN the pipeline SHALL deploy by updating ECS task definitions to the new image tags via CDK.
4. WHEN a new task revision is deployed THEN ECS SHALL use ALB `/healthz` health checks and a deployment circuit breaker to verify the new tasks.
5. IF new tasks fail health checks THEN ECS SHALL automatically roll back to the last stable task definition.
6. WHERE GitHub Actions authenticates to AWS THE pipeline SHALL use OIDC role assumption and SHALL NOT store long-lived AWS access keys.

### Requirement 11: Observability

**User Story:** As an operator, I want logs, metrics, alarms, and dashboards, so that I can monitor system health and demonstrate ML engineering observability in class.

#### Acceptance Criteria

1. WHERE services and the training job run THE system SHALL emit structured logs to CloudWatch Logs.
2. WHERE operational metrics matter THE system SHALL publish CloudWatch metrics and alarms for at least ALB 5xx rate, target health, RDS CPU and connections, ECS task failures, and model-load failures.
3. WHERE teaching visualization is needed THE system SHALL provide a CloudWatch dashboard showing request latency, recommendation strategy distribution, and A/B click-through rate by variant.

### Requirement 12: Security

**User Story:** As a security-conscious engineer, I want secrets protected and access least-privileged, so that the demo reflects enterprise security practices.

#### Acceptance Criteria

1. WHERE credentials are needed THE system SHALL store database credentials and the JWT signing key in AWS Secrets Manager and inject them into tasks at runtime, never baking them into images or source.
2. WHERE IAM roles are assigned THE system SHALL scope task roles to only the specific S3 buckets, secrets, and resources each service uses (least privilege).
3. WHERE admin-only capabilities exist (model reload, experiment metrics) THE system SHALL require an administrative claim in the JWT to authorize them.
4. WHERE data is transmitted THE system SHALL enforce HTTPS end-to-end from the browser through CloudFront to the ALB.

## Glossary

- **ALS (Alternating Least Squares):** An implicit-feedback collaborative filtering algorithm that learns user and item latent factor matrices by alternately fixing one and solving for the other.
- **A/B Test:** A controlled experiment comparing two variants (here, control = rule-based, treatment = ML-based) to measure their effect on a metric such as click-through rate.
- **ACM (AWS Certificate Manager):** AWS service that provisions and manages TLS certificates. CloudFront requires certificates in us-east-1; the ALB uses a certificate in us-east-2.
- **ALB (Application Load Balancer):** Layer-7 load balancer that path-routes HTTPS traffic to the Fargate services and performs health checks.
- **Candidate Set:** The bounded pool of items (recent/popular) considered for scoring on a given recommendation request.
- **CDK (AWS Cloud Development Kit):** Infrastructure-as-code framework (used here in TypeScript) for defining and deploying all AWS resources.
- **CloudFront:** AWS global CDN that terminates TLS at the edge and forwards requests to the ALB origin.
- **Cold Start:** The condition where a user (or item) is unknown to the trained model, triggering a fallback to rule-based recommendations.
- **CTR (Click-Through Rate):** Ratio of click events to view events, used to compare experiment variants.
- **Deployment Circuit Breaker:** ECS feature that detects failed deployments via health checks and automatically rolls back to the last stable task definition.
- **EARS:** Easy Approach to Requirements Syntax; the WHEN/IF/WHERE/THE...SHALL format used for acceptance criteria in this document.
- **ECS / Fargate:** AWS container orchestration (ECS) with serverless compute (Fargate) hosting the SSR frontend, microservices, and training task.
- **Feature Flag:** A runtime toggle (with master enable, default variant, and rollout percent) controlling which recommendation strategy a user receives.
- **Implicit Feedback:** Interaction signals (view, click, complete) used as positive-preference proxies with confidence weights, rather than explicit ratings.
- **JWT (JSON Web Token):** Signed token representing an authenticated session; admin capabilities require an administrative claim.
- **OIDC (OpenID Connect):** Federation mechanism allowing GitHub Actions to assume an AWS role without storing long-lived access keys.
- **RDS:** Amazon Relational Database Service hosting the PostgreSQL database for users, items, interactions, flags, and experiment assignments.
- **Recall@k:** Offline evaluation metric measuring the fraction of relevant items captured in the top-k recommendations.
- **Rollout Percent:** The 0–100 value determining the proportion of users deterministically assigned to the treatment (ML-based) variant.
- **SSR (Server-Side Rendering):** Rendering pages on the server (Fargate), so the frontend runs on AWS rather than on the local machine.
- **Sticky Assignment:** Property guaranteeing a given user always resolves to the same experiment variant across requests.
