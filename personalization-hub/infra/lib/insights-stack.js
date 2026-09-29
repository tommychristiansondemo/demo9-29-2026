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
exports.InsightsStack = void 0;
const aws_cdk_lib_1 = require("aws-cdk-lib");
const s3 = __importStar(require("aws-cdk-lib/aws-s3"));
const lambda = __importStar(require("aws-cdk-lib/aws-lambda"));
const apigw = __importStar(require("aws-cdk-lib/aws-apigatewayv2"));
const apigwi = __importStar(require("aws-cdk-lib/aws-apigatewayv2-integrations"));
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const logs = __importStar(require("aws-cdk-lib/aws-logs"));
const path = __importStar(require("path"));
const ROOT = path.join(__dirname, "..", "..");
const REASONING_LOG_GROUP = "/personalization-hub/llm-reasoning";
const CHATBOT_LOG_GROUP = "/personalization-hub/chatbot-reasoning";
const BEDROCK_MODEL_ID = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
/**
 * The Insights App: a fully serverless companion that explains the deployment.
 * Static site in S3 (public website), dynamic content via Lambda behind an
 * HTTP API, with a Bedrock-backed chatbot grounded in projectknowledge.md.
 */
class InsightsStack extends aws_cdk_lib_1.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        // Knowledge base bucket (holds projectknowledge.md, read by the chatbot).
        // Contents are uploaded post-deploy via the AWS CLI (see deploy steps),
        // avoiding the BucketDeployment custom resource.
        const kbBucket = new s3.Bucket(this, "KnowledgeBucket", {
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            encryption: s3.BucketEncryption.S3_MANAGED,
            removalPolicy: aws_cdk_lib_1.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
        });
        // Chatbot Lambda-reasoning log group (its own prompts/responses).
        const chatbotLogGroup = new logs.LogGroup(this, "ChatbotReasoningLogs", {
            logGroupName: CHATBOT_LOG_GROUP,
            retention: logs.RetentionDays.TWO_WEEKS,
            removalPolicy: aws_cdk_lib_1.RemovalPolicy.DESTROY,
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
            timeout: aws_cdk_lib_1.Duration.seconds(60),
            memorySize: 512,
            environment: commonEnv,
        });
        const logsFn = new lambda.Function(this, "LogsFn", {
            runtime: lambda.Runtime.PYTHON_3_12,
            handler: "handler.handler",
            code: lambda.Code.fromAsset(path.join(ROOT, "insights", "lambda", "logs")),
            timeout: aws_cdk_lib_1.Duration.seconds(30),
            memorySize: 256,
            environment: commonEnv,
        });
        // Permissions: read KB, invoke Bedrock, read reasoning logs, write chatbot logs.
        kbBucket.grantRead(chatbotFn);
        chatbotFn.addToRolePolicy(new iam.PolicyStatement({
            actions: ["bedrock:InvokeModel", "bedrock:Converse"],
            resources: ["*"],
        }));
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
        logsFn.addToRolePolicy(new iam.PolicyStatement({
            actions: ["logs:DescribeLogStreams", "logs:GetLogEvents"],
            resources: [
                `arn:aws:logs:${this.region}:${this.account}:log-group:${REASONING_LOG_GROUP}:*`,
                `arn:aws:logs:${this.region}:${this.account}:log-group:${CHATBOT_LOG_GROUP}:*`,
            ],
        }));
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
            removalPolicy: aws_cdk_lib_1.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
        });
        this.siteUrl = siteBucket.bucketWebsiteUrl;
        this.apiEndpoint = httpApi.apiEndpoint;
        new aws_cdk_lib_1.CfnOutput(this, "InsightsSiteUrl", { value: siteBucket.bucketWebsiteUrl });
        new aws_cdk_lib_1.CfnOutput(this, "InsightsApiUrl", { value: httpApi.apiEndpoint });
        new aws_cdk_lib_1.CfnOutput(this, "KnowledgeBucketName", { value: kbBucket.bucketName });
        new aws_cdk_lib_1.CfnOutput(this, "SiteBucketName", { value: siteBucket.bucketName });
    }
}
exports.InsightsStack = InsightsStack;
