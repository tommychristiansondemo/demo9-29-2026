import { Duration, Stack, StackProps } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecr_assets from "aws-cdk-lib/aws-ecr-assets";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as rds from "aws-cdk-lib/aws-rds";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as logs from "aws-cdk-lib/aws-logs";
import * as iam from "aws-cdk-lib/aws-iam";
import { RemovalPolicy } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as path from "path";
import { CONFIG } from "./config";

interface ServicesStackProps extends StackProps {
  vpc: ec2.Vpc;
  db: rds.DatabaseInstance;
  dbSecret: secretsmanager.ISecret;
  jwtSecret: secretsmanager.Secret;
  modelBucket: s3.Bucket;
  insightsUrl?: string;
  modelsApiUrl?: string;
  appConfig?: { appId: string; envId: string; profileId: string };
}

const ROOT = path.join(__dirname, "..", "..");

export class ServicesStack extends Stack {
  public readonly alb: elbv2.ApplicationLoadBalancer;
  public readonly cluster: ecs.Cluster;
  public readonly reasoningLogGroupName!: string;

  constructor(scope: Construct, id: string, props: ServicesStackProps) {
    super(scope, id, props);

    const zone = route53.HostedZone.fromHostedZoneAttributes(this, "Zone", {
      hostedZoneId: CONFIG.hostedZoneId,
      zoneName: CONFIG.hostedZoneName,
    });

    // Regional ACM cert for the ALB (us-east-2).
    const albCert = new acm.Certificate(this, "AlbCert", {
      domainName: CONFIG.domainName,
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
      removalPolicy: RemovalPolicy.DESTROY,
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

    const makeService = (
      name: string,
      dir: string,
      containerPort: number,
      healthPath: string,
      extraEnv: Record<string, string> = {},
      extraSecrets: Record<string, ecs.Secret> = {}
    ) => {
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
        healthCheckGracePeriod: Duration.seconds(120),
      });

      const tg = new elbv2.ApplicationTargetGroup(this, `${name}Tg`, {
        vpc: props.vpc,
        port: containerPort,
        protocol: elbv2.ApplicationProtocol.HTTP,
        targets: [service],
        healthCheck: {
          path: healthPath,
          interval: Duration.seconds(30),
          healthyHttpCodes: "200",
        },
        deregistrationDelay: Duration.seconds(15),
      });

      return { tg, taskDef };
    };

    // Recommendation service (Python/FastAPI).
    const rec = makeService(
      "Rec",
      path.join(ROOT, "services", "recommendation"),
      8080,
      "/healthz",
      {
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
      },
      {}
    );
    const recTg = rec.tg;

    // User profile service (Node/Express).
    const userTg = makeService(
      "User",
      path.join(ROOT, "services", "user-profile"),
      8080,
      "/healthz"
    ).tg;

    // Frontend (Next.js SSR).
    const feTg = makeService(
      "Fe",
      path.join(ROOT, "frontend"),
      3000,
      "/api/healthz",
      {
        INTERNAL_API_URL: `https://${CONFIG.domainName}`,
        ...(props.insightsUrl ? { INSIGHTS_URL: props.insightsUrl } : {}),
        ...(props.modelsApiUrl ? { MODELS_API_URL: props.modelsApiUrl } : {}),
      }
    ).tg;

    // Grant the recommendation service read access to the model bucket.
    props.modelBucket.grantRead(rec.taskDef.taskRole);

    // Allow the recommendation service to invoke Bedrock (LLM explanations) and
    // write reasoning traces to the dedicated log group.
    rec.taskDef.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel", "bedrock:Converse"],
        resources: ["*"],
      })
    );
    reasoningLogGroup.grantWrite(rec.taskDef.taskRole);

    // Allow the recommendation service to read the selected model from AppConfig.
    rec.taskDef.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: [
          "appconfig:StartConfigurationSession",
          "appconfig:GetLatestConfiguration",
        ],
        resources: ["*"],
      })
    );

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
