import { Stack, StackProps } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecr_assets from "aws-cdk-lib/aws-ecr-assets";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as rds from "aws-cdk-lib/aws-rds";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as logs from "aws-cdk-lib/aws-logs";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import * as path from "path";

interface TrainingStackProps extends StackProps {
  vpc: ec2.Vpc;
  cluster: ecs.Cluster;
  db: rds.DatabaseInstance;
  dbSecret: secretsmanager.ISecret;
  modelBucket: s3.Bucket;
}

const ROOT = path.join(__dirname, "..", "..");

export class TrainingStack extends Stack {
  constructor(scope: Construct, id: string, props: TrainingStackProps) {
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
    taskDef.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["cloudwatch:PutMetricData"],
        resources: ["*"],
      })
    );

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
