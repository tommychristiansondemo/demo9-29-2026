import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import * as apigwi from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import * as path from "path";

const ROOT = path.join(__dirname, "..", "..");

const REASONING_LOG_GROUP = "/personalization-hub/llm-reasoning";
const CHATBOT_LOG_GROUP = "/personalization-hub/chatbot-reasoning";
const BEDROCK_MODEL_ID = "us.anthropic.claude-haiku-4-5-20251001-v1:0";

/**
 * The Insights App: a fully serverless companion that explains the deployment.
 * Static site in S3 (public website), dynamic content via Lambda behind an
 * HTTP API, with a Bedrock-backed chatbot grounded in projectknowledge.md.
 */
export class InsightsStack extends Stack {
  public readonly siteUrl: string;
  public readonly apiEndpoint!: string;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Knowledge base bucket (holds projectknowledge.md, read by the chatbot).
    // Contents are uploaded post-deploy via the AWS CLI (see deploy steps),
    // avoiding the BucketDeployment custom resource.
    const kbBucket = new s3.Bucket(this, "KnowledgeBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Chatbot Lambda-reasoning log group (its own prompts/responses).
    const chatbotLogGroup = new logs.LogGroup(this, "ChatbotReasoningLogs", {
      logGroupName: CHATBOT_LOG_GROUP,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const commonEnv = {
      BEDROCK_MODEL_ID,
      KB_BUCKET: kbBucket.bucketName,
      KB_KEY: "projectknowledge.md",
      REASONING_LOG_GROUP,
      CHATBOT_LOG_GROUP,
    };

    const chatbotFn = new lambda.Function(this, "ChatbotFn", {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: "handler.handler",
      code: lambda.Code.fromAsset(path.join(ROOT, "insights", "lambda", "chatbot")),
      timeout: Duration.seconds(60),
      memorySize: 512,
      environment: commonEnv,
    });

    const logsFn = new lambda.Function(this, "LogsFn", {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: "handler.handler",
      code: lambda.Code.fromAsset(path.join(ROOT, "insights", "lambda", "logs")),
      timeout: Duration.seconds(30),
      memorySize: 256,
      environment: commonEnv,
    });

    // Permissions: read KB, invoke Bedrock, read reasoning logs, write chatbot logs.
    kbBucket.grantRead(chatbotFn);
    chatbotFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel", "bedrock:Converse"],
        resources: ["*"],
      })
    );
    const logReadWrite = new iam.PolicyStatement({
      actions: [
        "logs:DescribeLogStreams",
        "logs:GetLogEvents",
        "logs:CreateLogStream",
        "logs:PutLogEvents",
      ],
      resources: [
        `arn:aws:logs:${this.region}:${this.account}:log-group:${REASONING_LOG_GROUP}:*`,
        `arn:aws:logs:${this.region}:${this.account}:log-group:${CHATBOT_LOG_GROUP}:*`,
      ],
    });
    chatbotFn.addToRolePolicy(logReadWrite);
    logsFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["logs:DescribeLogStreams", "logs:GetLogEvents"],
        resources: [
          `arn:aws:logs:${this.region}:${this.account}:log-group:${REASONING_LOG_GROUP}:*`,
          `arn:aws:logs:${this.region}:${this.account}:log-group:${CHATBOT_LOG_GROUP}:*`,
        ],
      })
    );

    // HTTP API with CORS.
    const httpApi = new apigw.HttpApi(this, "InsightsApi", {
      corsPreflight: {
        allowOrigins: ["*"],
        allowMethods: [apigw.CorsHttpMethod.GET, apigw.CorsHttpMethod.POST, apigw.CorsHttpMethod.OPTIONS],
        allowHeaders: ["Content-Type"],
      },
    });
    httpApi.addRoutes({
      path: "/chat",
      methods: [apigw.HttpMethod.POST],
      integration: new apigwi.HttpLambdaIntegration("ChatInt", chatbotFn),
    });
    httpApi.addRoutes({
      path: "/logs",
      methods: [apigw.HttpMethod.GET],
      integration: new apigwi.HttpLambdaIntegration("LogsInt", logsFn),
    });

    // Static website bucket (public). Files uploaded post-deploy via CLI.
    const siteBucket = new s3.Bucket(this, "SiteBucket", {
      websiteIndexDocument: "index.html",
      publicReadAccess: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ACLS,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    this.siteUrl = siteBucket.bucketWebsiteUrl;
    this.apiEndpoint = httpApi.apiEndpoint;

    new CfnOutput(this, "InsightsSiteUrl", { value: siteBucket.bucketWebsiteUrl });
    new CfnOutput(this, "InsightsApiUrl", { value: httpApi.apiEndpoint });
    new CfnOutput(this, "KnowledgeBucketName", { value: kbBucket.bucketName });
    new CfnOutput(this, "SiteBucketName", { value: siteBucket.bucketName });
  }
}
