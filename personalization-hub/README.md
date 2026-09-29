# Personalization Hub

An enterprise-quality content recommendation application built as a teaching example for a Machine Learning Engineering class. Authenticated users log into a mini "GoTo learning center" and see personalized recommendations for content items (articles, videos, internal docs).

## Architecture

- **Frontend**: Next.js SSR app (Fargate), served through CloudFront at `personalize.awsteach.com`.
- **User Profile Service**: Node/Express/TypeScript microservice (auth, profiles, JWT).
- **Recommendation Service**: Python/FastAPI microservice (feature flags, A/B, ML + rule-based recommendations).
- **Training**: Python offline ALS collaborative-filtering job (scheduled Fargate task) writing model artifacts to S3.
- **Data**: RDS PostgreSQL; S3 for model artifacts & training snapshots.
- **Infra**: AWS CDK (TypeScript), region `us-east-2` (CloudFront ACM cert in `us-east-1`).

## Runtime guarantee

Every runtime component runs on AWS-managed resources. After `cdk deploy` succeeds and images are pushed to ECR, the local build/chat server can be turned off with no impact on the running application.

## Layout

```
personalization-hub/
  services/
    recommendation/     # Python FastAPI service + shared domain logic
    user-profile/       # Node/TS Express service
  training/             # Python ALS training job
  frontend/             # Next.js SSR app
  infra/                # AWS CDK (TypeScript)
  .github/workflows/    # CI/CD (GitHub Actions -> ECR -> CDK/ECS)
```

## Local development

- Recommendation service: `cd services/recommendation && pip install -e ".[dev]" && pytest`
- User profile service: `cd services/user-profile && npm install && npm test`
- Infra: `cd infra && npm install && npx cdk synth`
