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
exports.ServicesStack = void 0;
const aws_cdk_lib_1 = require("aws-cdk-lib");
const ec2 = __importStar(require("aws-cdk-lib/aws-ec2"));
const ecs = __importStar(require("aws-cdk-lib/aws-ecs"));
const ecr_assets = __importStar(require("aws-cdk-lib/aws-ecr-assets"));
const elbv2 = __importStar(require("aws-cdk-lib/aws-elasticloadbalancingv2"));
const acm = __importStar(require("aws-cdk-lib/aws-certificatemanager"));
const route53 = __importStar(require("aws-cdk-lib/aws-route53"));
const logs = __importStar(require("aws-cdk-lib/aws-logs"));
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const aws_cdk_lib_2 = require("aws-cdk-lib");
const path = __importStar(require("path"));
const config_1 = require("./config");
const ROOT = path.join(__dirname, "..", "..");
class ServicesStack extends aws_cdk_lib_1.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        const zone = route53.HostedZone.fromHostedZoneAttributes(this, "Zone", {
            hostedZoneId: config_1.CONFIG.hostedZoneId,
            zoneName: config_1.CONFIG.hostedZoneName,
        });
        // Regional ACM cert for the ALB (us-east-2).
        const albCert = new acm.Certificate(this, "AlbCert", {
            domainName: config_1.CONFIG.domainName,
            validation: acm.CertificateValidation.fromDns(zone),
        });
        this.cluster = new ecs.Cluster(this, "Cluster", {
            vpc: props.vpc,
            containerInsights: true,
        });
        // Dedicated log group for LLM reasoning traces (every Bedrock prompt +
        // response from the recommendation explainer). Shared name so the insights
        // app can read it too.
        const reasoningLogGroup = new logs.LogGroup(this, "LlmReasoningLogs", {
            logGroupName: "/personalization-hub/llm-reasoning",
            retention: logs.RetentionDays.TWO_WEEKS,
            removalPolicy: aws_cdk_lib_2.RemovalPolicy.DESTROY,
        });
        this.reasoningLogGroupName = reasoningLogGroup.logGroupName;
        // Build DATABASE_URL from the RDS secret at runtime via env indirection.
        const dbHost = props.db.dbInstanceEndpointAddress;
        const dbPort = props.db.dbInstanceEndpointPort;
        const commonSecrets = {
            DB_USER: ecs.Secret.fromSecretsManager(props.dbSecret, "username"),
            DB_PASS: ecs.Secret.fromSecretsManager(props.dbSecret, "password"),
            JWT_SECRET: ecs.Secret.fromSecretsManager(props.jwtSecret),
        };
        const dbUrlEnv = {
            DB_HOST: dbHost,
            DB_PORT: dbPort,
            DB_NAME: "personalize",
        };
        // Service SG (co-located with the ALB SG). DB access is granted by also
        // attaching the DataStack's dbClient SG to each task, so this stack never
        // mutates the DB security group (avoids cross-stack cycles).
        const serviceSg = new ec2.SecurityGroup(this, "ServiceSg", {
            vpc: props.vpc,
            allowAllOutbound: true,
            description: "Fargate services",
        });
        // ---- ALB ----
        const albSg = new ec2.SecurityGroup(this, "AlbSg", {
            vpc: props.vpc,
            allowAllOutbound: true,
            description: "ALB",
        });
        albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), "HTTPS");
        albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), "HTTP redirect");
        // ALB -> service ingress rules are created automatically when target
        // groups are attached to the listener (via connections), so no manual
        // cross-stack security-group mutation is needed here.
        this.alb = new elbv2.ApplicationLoadBalancer(this, "Alb", {
            vpc: props.vpc,
            internetFacing: true,
            securityGroup: albSg,
        });
        // HTTP -> HTTPS redirect.
        this.alb.addListener("HttpRedirect", {
            port: 80,
            defaultAction: elbv2.ListenerAction.redirect({
                protocol: "HTTPS",
                port: "443",
                permanent: true,
            }),
        });
        const httpsListener = this.alb.addListener("Https", {
            port: 443,
            certificates: [albCert],
            open: true,
        });
        const makeService = (name, dir, containerPort, healthPath, extraEnv = {}, extraSecrets = {}) => {
            const image = new ecr_assets.DockerImageAsset(this, `${name}Image`, {
                directory: dir,
                platform: ecr_assets.Platform.LINUX_AMD64,
            });
            const taskDef = new ecs.FargateTaskDefinition(this, `${name}Task`, {
                cpu: 512,
                memoryLimitMiB: 1024,
            });
            const logGroup = new logs.LogGroup(this, `${name}Logs`, {
                retention: logs.RetentionDays.ONE_WEEK,
            });
            taskDef.addContainer(`${name}Container`, {
                image: ecs.ContainerImage.fromDockerImageAsset(image),
                portMappings: [{ containerPort }],
                environment: { ...dbUrlEnv, ...extraEnv },
                secrets: { ...commonSecrets, ...extraSecrets },
                logging: ecs.LogDrivers.awsLogs({ streamPrefix: name, logGroup }),
            });
            const service = new ecs.FargateService(this, `${name}Service`, {
                cluster: this.cluster,
                taskDefinition: taskDef,
                desiredCount: 1,
                securityGroups: [serviceSg],
                vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
                circuitBreaker: { rollback: true },
                healthCheckGracePeriod: aws_cdk_lib_1.Duration.seconds(120),
            });
            const tg = new elbv2.ApplicationTargetGroup(this, `${name}Tg`, {
                vpc: props.vpc,
                port: containerPort,
                protocol: elbv2.ApplicationProtocol.HTTP,
                targets: [service],
                healthCheck: {
                    path: healthPath,
                    interval: aws_cdk_lib_1.Duration.seconds(30),
                    healthyHttpCodes: "200",
                },
                deregistrationDelay: aws_cdk_lib_1.Duration.seconds(15),
            });
            return { tg, taskDef };
        };
        // Recommendation service (Python/FastAPI).
        const rec = makeService("Rec", path.join(ROOT, "services", "recommendation"), 8080, "/healthz", {
            MODEL_BUCKET: props.modelBucket.bucketName,
            BEDROCK_MODEL_ID: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
            REASONING_LOG_GROUP: "/personalization-hub/llm-reasoning",
            TREATMENT_STRATEGY: "llm-enhanced",
            ...(props.appConfig
                ? {
                    APPCONFIG_APP_ID: props.appConfig.appId,
                    APPCONFIG_ENV_ID: props.appConfig.envId,
                    APPCONFIG_PROFILE_ID: props.appConfig.profileId,
                }
                : {}),
        }, {});
        const recTg = rec.tg;
        // User profile service (Node/Express).
        const userTg = makeService("User", path.join(ROOT, "services", "user-profile"), 8080, "/healthz").tg;
        // Frontend (Next.js SSR).
        const feTg = makeService("Fe", path.join(ROOT, "frontend"), 3000, "/api/healthz", {
            INTERNAL_API_URL: `https://${config_1.CONFIG.domainName}`,
            ...(props.insightsUrl ? { INSIGHTS_URL: props.insightsUrl } : {}),
            ...(props.modelsApiUrl ? { MODELS_API_URL: props.modelsApiUrl } : {}),
        }).tg;
        // Grant the recommendation service read access to the model bucket.
        props.modelBucket.grantRead(rec.taskDef.taskRole);
        // Allow the recommendation service to invoke Bedrock (LLM explanations) and
        // write reasoning traces to the dedicated log group.
        rec.taskDef.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
            actions: ["bedrock:InvokeModel", "bedrock:Converse"],
            resources: ["*"],
        }));
        reasoningLogGroup.grantWrite(rec.taskDef.taskRole);
        // Allow the recommendation service to read the selected model from AppConfig.
        rec.taskDef.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
            actions: [
                "appconfig:StartConfigurationSession",
                "appconfig:GetLatestConfiguration",
            ],
            resources: ["*"],
        }));
        // ---- Listener routing ----
        httpsListener.addTargetGroups("DefaultFe", { targetGroups: [feTg] });
        // User routes take priority so /api/users and /api/profile go to the user
        // service; everything else under /api or /admin goes to recommendation.
        httpsListener.addTargetGroups("UserRoute", {
            priority: 10,
            conditions: [
                elbv2.ListenerCondition.pathPatterns([
                    "/api/users",
                    "/api/users/*",
                    "/api/profile",
                    "/api/profile/*",
                ]),
            ],
            targetGroups: [userTg],
        });
        httpsListener.addTargetGroups("RecRoute", {
            priority: 20,
            conditions: [
                elbv2.ListenerCondition.pathPatterns([
                    "/api/recommendations",
                    "/api/recommendations/*",
                    "/api/interactions*",
                    "/api/experiments/*",
                    "/admin/*",
                ]),
            ],
            targetGroups: [recTg],
        });
        httpsListener.addTargetGroups("FlagsRoute", {
            priority: 30,
            conditions: [
                elbv2.ListenerCondition.pathPatterns(["/api/flags/*", "/api/items", "/api/items/*"]),
            ],
            targetGroups: [recTg],
        });
    }
}
exports.ServicesStack = ServicesStack;
