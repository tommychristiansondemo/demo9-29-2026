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
exports.TrainingStack = void 0;
const aws_cdk_lib_1 = require("aws-cdk-lib");
const ec2 = __importStar(require("aws-cdk-lib/aws-ec2"));
const ecs = __importStar(require("aws-cdk-lib/aws-ecs"));
const ecr_assets = __importStar(require("aws-cdk-lib/aws-ecr-assets"));
const events = __importStar(require("aws-cdk-lib/aws-events"));
const targets = __importStar(require("aws-cdk-lib/aws-events-targets"));
const logs = __importStar(require("aws-cdk-lib/aws-logs"));
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const path = __importStar(require("path"));
const ROOT = path.join(__dirname, "..", "..");
class TrainingStack extends aws_cdk_lib_1.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        const image = new ecr_assets.DockerImageAsset(this, "TrainImage", {
            directory: path.join(ROOT, "training"),
            platform: ecr_assets.Platform.LINUX_AMD64,
        });
        const taskDef = new ecs.FargateTaskDefinition(this, "TrainTask", {
            cpu: 1024,
            memoryLimitMiB: 2048,
        });
        const logGroup = new logs.LogGroup(this, "TrainLogs", {
            retention: logs.RetentionDays.ONE_WEEK,
        });
        taskDef.addContainer("TrainContainer", {
            image: ecs.ContainerImage.fromDockerImageAsset(image),
            environment: {
                DB_HOST: props.db.dbInstanceEndpointAddress,
                DB_PORT: props.db.dbInstanceEndpointPort,
                DB_NAME: "personalize",
                MODEL_BUCKET: props.modelBucket.bucketName,
            },
            secrets: {
                DB_USER: ecs.Secret.fromSecretsManager(props.dbSecret, "username"),
                DB_PASS: ecs.Secret.fromSecretsManager(props.dbSecret, "password"),
            },
            logging: ecs.LogDrivers.awsLogs({ streamPrefix: "training", logGroup }),
        });
        props.modelBucket.grantReadWrite(taskDef.taskRole);
        taskDef.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
            actions: ["cloudwatch:PutMetricData"],
            resources: ["*"],
        }));
        const trainSg = new ec2.SecurityGroup(this, "TrainSg", {
            vpc: props.vpc,
            allowAllOutbound: true,
            description: "Training task",
        });
        // Nightly schedule (02:00 UTC). DB access via the shared dbClient SG.
        new events.Rule(this, "TrainSchedule", {
            schedule: events.Schedule.cron({ minute: "0", hour: "2" }),
            targets: [
                new targets.EcsTask({
                    cluster: props.cluster,
                    taskDefinition: taskDef,
                    subnetSelection: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
                    securityGroups: [trainSg],
                }),
            ],
        });
    }
}
exports.TrainingStack = TrainingStack;
