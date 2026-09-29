#!/usr/bin/env node
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
require("source-map-support/register");
const cdk = __importStar(require("aws-cdk-lib"));
const config_1 = require("../lib/config");
const network_stack_1 = require("../lib/network-stack");
const data_stack_1 = require("../lib/data-stack");
const certificate_stack_1 = require("../lib/certificate-stack");
const services_stack_1 = require("../lib/services-stack");
const edge_stack_1 = require("../lib/edge-stack");
const training_stack_1 = require("../lib/training-stack");
const observability_stack_1 = require("../lib/observability-stack");
const insights_stack_1 = require("../lib/insights-stack");
const modelconfig_stack_1 = require("../lib/modelconfig-stack");
const app = new cdk.App();
const regionEnv = { account: config_1.CONFIG.account, region: config_1.CONFIG.region };
const certEnv = { account: config_1.CONFIG.account, region: config_1.CONFIG.certRegion };
// us-east-1 certificate for CloudFront (referenced cross-region).
const certStack = new certificate_stack_1.CertificateStack(app, "PhCertificate", {
    env: certEnv,
    crossRegionReferences: true,
});
const network = new network_stack_1.NetworkStack(app, "PhNetwork", { env: regionEnv });
const data = new data_stack_1.DataStack(app, "PhData", {
    env: regionEnv,
    vpc: network.vpc,
});
// Insights App (independent; no dependency on the main services stack).
const insights = new insights_stack_1.InsightsStack(app, "PhInsights", { env: regionEnv });
// Model-selection: AppConfig + selector Lambda + its own HTTP API (independent).
const modelConfig = new modelconfig_stack_1.ModelConfigStack(app, "PhModelConfig", { env: regionEnv });
const services = new services_stack_1.ServicesStack(app, "PhServices", {
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
const edge = new edge_stack_1.EdgeStack(app, "PhEdge", {
    env: regionEnv,
    crossRegionReferences: true,
    alb: services.alb,
    certificate: certStack.certificate,
});
edge.addDependency(services);
const training = new training_stack_1.TrainingStack(app, "PhTraining", {
    env: regionEnv,
    vpc: network.vpc,
    cluster: services.cluster,
    db: data.db,
    dbSecret: data.dbSecret,
    modelBucket: data.modelBucket,
});
training.addDependency(services);
new observability_stack_1.ObservabilityStack(app, "PhObservability", {
    env: regionEnv,
    alb: services.alb,
    db: data.db,
});
app.synth();
