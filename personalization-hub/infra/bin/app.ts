#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { CONFIG } from "../lib/config";
import { NetworkStack } from "../lib/network-stack";
import { DataStack } from "../lib/data-stack";
import { CertificateStack } from "../lib/certificate-stack";
import { ServicesStack } from "../lib/services-stack";
import { EdgeStack } from "../lib/edge-stack";
import { TrainingStack } from "../lib/training-stack";
import { ObservabilityStack } from "../lib/observability-stack";
import { InsightsStack } from "../lib/insights-stack";
import { ModelConfigStack } from "../lib/modelconfig-stack";

const app = new cdk.App();

const regionEnv = { account: CONFIG.account, region: CONFIG.region };
const certEnv = { account: CONFIG.account, region: CONFIG.certRegion };

// us-east-1 certificate for CloudFront (referenced cross-region).
const certStack = new CertificateStack(app, "PhCertificate", {
  env: certEnv,
  crossRegionReferences: true,
});

const network = new NetworkStack(app, "PhNetwork", { env: regionEnv });

const data = new DataStack(app, "PhData", {
  env: regionEnv,
  vpc: network.vpc,
});

// Insights App (independent; no dependency on the main services stack).
const insights = new InsightsStack(app, "PhInsights", { env: regionEnv });

// Model-selection: AppConfig + selector Lambda + its own HTTP API (independent).
const modelConfig = new ModelConfigStack(app, "PhModelConfig", { env: regionEnv });

const services = new ServicesStack(app, "PhServices", {
  env: regionEnv,
  vpc: network.vpc,
  db: data.db,
  dbSecret: data.dbSecret,
  jwtSecret: data.jwtSecret,
  modelBucket: data.modelBucket,
  insightsUrl: insights.siteUrl,
  modelsApiUrl: modelConfig.apiEndpoint,
  appConfig: {
    appId: modelConfig.appId,
    envId: modelConfig.envId,
    profileId: modelConfig.profileId,
  },
});
services.addDependency(insights);
services.addDependency(modelConfig);

const edge = new EdgeStack(app, "PhEdge", {
  env: regionEnv,
  crossRegionReferences: true,
  alb: services.alb,
  certificate: certStack.certificate,
});
edge.addDependency(services);

const training = new TrainingStack(app, "PhTraining", {
  env: regionEnv,
  vpc: network.vpc,
  cluster: services.cluster,
  db: data.db,
  dbSecret: data.dbSecret,
  modelBucket: data.modelBucket,
});
training.addDependency(services);

new ObservabilityStack(app, "PhObservability", {
  env: regionEnv,
  alb: services.alb,
  db: data.db,
});

app.synth();
