import { CfnOutput, Duration, Stack, StackProps } from "aws-cdk-lib";
import * as appconfig from "aws-cdk-lib/aws-appconfig";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as iam from "aws-cdk-lib/aws-iam";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import * as apigwi from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { Construct } from "constructs";
import * as path from "path";

const ROOT = path.join(__dirname, "..", "..");

// The five candidate models with normalized strength scores (0..1).
// quality: higher is better output quality.
// cost:    higher means cheaper (better on cost).
// latency: higher means faster (better on latency).
const MODEL_CATALOG = [
  { id: "us.anthropic.claude-opus-4-5-20251101-v1:0", name: "Claude Opus 4.5", quality: 1.0, cost: 0.15, latency: 0.3 },
  { id: "us.anthropic.claude-sonnet-4-5-20250929-v1:0", name: "Claude Sonnet 4.5", quality: 0.85, cost: 0.55, latency: 0.65 },
  { id: "us.anthropic.claude-haiku-4-5-20251001-v1:0", name: "Claude Haiku 4.5", quality: 0.65, cost: 0.9, latency: 0.95 },
  { id: "us.amazon.nova-pro-v1:0", name: "Amazon Nova Pro", quality: 0.7, cost: 0.8, latency: 0.8 },
  { id: "us.amazon.nova-lite-v1:0", name: "Amazon Nova Lite", quality: 0.45, cost: 1.0, latency: 1.0 },
];

const INITIAL_CONFIG = {
  weights: { quality: 50, cost: 25, latency: 25 },
  selectedModelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
  models: MODEL_CATALOG,
};

export class ModelConfigStack extends Stack {
  public readonly appId: string;
  public readonly envId: string;
  public readonly profileId: string;
  public readonly apiEndpoint!: string;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const app = new appconfig.CfnApplication(this, "App", {
      name: "personalization-hub-models",
    });
    const env = new appconfig.CfnEnvironment(this, "Env", {
      applicationId: app.ref,
      name: "prod",
    });
    const profile = new appconfig.CfnConfigurationProfile(this, "Profile", {
      applicationId: app.ref,
      name: "model-preferences",
      locationUri: "hosted",
      type: "AWS.Freeform",
    });
    const version = new appconfig.CfnHostedConfigurationVersion(this, "InitialVersion", {
      applicationId: app.ref,
      configurationProfileId: profile.ref,
      contentType: "application/json",
      content: JSON.stringify(INITIAL_CONFIG),
    });
    // Deploy instantly (0 min bake) for a responsive classroom demo.
    const strategy = new appconfig.CfnDeploymentStrategy(this, "Strategy", {
      name: "ph-instant",
      deploymentDurationInMinutes: 0,
      growthFactor: 100,
      finalBakeTimeInMinutes: 0,
      replicateTo: "NONE",
    });
    new appconfig.CfnDeployment(this, "InitialDeployment", {
      applicationId: app.ref,
      environmentId: env.ref,
      configurationProfileId: profile.ref,
      configurationVersion: version.ref,
      deploymentStrategyId: strategy.ref,
    });

    this.appId = app.ref;
    this.envId = env.ref;
    this.profileId = profile.ref;

    // Model-selector Lambda: reads/writes weights in AppConfig, ranks models,
    // and updates the selected model live.
    const selectorFn = new lambda.Function(this, "ModelSelectorFn", {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: "handler.handler",
      code: lambda.Code.fromAsset(path.join(ROOT, "insights", "lambda", "modelselector")),
      timeout: Duration.seconds(30),
      memorySize: 256,
      environment: {
        APPCONFIG_APP_ID: app.ref,
        APPCONFIG_ENV_ID: env.ref,
        APPCONFIG_PROFILE_ID: profile.ref,
        APPCONFIG_STRATEGY_ID: strategy.ref,
      },
    });

    selectorFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "appconfig:GetLatestConfiguration",
          "appconfig:StartConfigurationSession",
          "appconfig:CreateHostedConfigurationVersion",
          "appconfig:StartDeployment",
          "appconfig:GetConfiguration",
          "appconfig:ListDeployments",
        ],
        resources: ["*"],
      })
    );

    const httpApi = new apigw.HttpApi(this, "ModelsApi", {
      corsPreflight: {
        allowOrigins: ["*"],
        allowMethods: [apigw.CorsHttpMethod.GET, apigw.CorsHttpMethod.POST, apigw.CorsHttpMethod.OPTIONS],
        allowHeaders: ["Content-Type"],
      },
    });
    const integration = new apigwi.HttpLambdaIntegration("ModelsInt", selectorFn);
    httpApi.addRoutes({ path: "/models", methods: [apigw.HttpMethod.GET], integration });
    httpApi.addRoutes({ path: "/models", methods: [apigw.HttpMethod.POST], integration });

    this.apiEndpoint = httpApi.apiEndpoint;

    new CfnOutput(this, "ModelsApiUrl", { value: httpApi.apiEndpoint });
    new CfnOutput(this, "AppConfigAppId", { value: app.ref });
    new CfnOutput(this, "AppConfigEnvId", { value: env.ref });
    new CfnOutput(this, "AppConfigProfileId", { value: profile.ref });
  }
}
