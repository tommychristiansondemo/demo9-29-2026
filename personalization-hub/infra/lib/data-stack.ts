import { RemovalPolicy, Stack, StackProps, Duration } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as rds from "aws-cdk-lib/aws-rds";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";

interface DataStackProps extends StackProps {
  vpc: ec2.Vpc;
}

export class DataStack extends Stack {
  public readonly db: rds.DatabaseInstance;
  public readonly dbSecret: secretsmanager.ISecret;
  public readonly jwtSecret: secretsmanager.Secret;
  public readonly modelBucket: s3.Bucket;
  public readonly dbSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    this.modelBucket = new s3.Bucket(this, "ModelBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    this.jwtSecret = new secretsmanager.Secret(this, "JwtSecret", {
      generateSecretString: {
        passwordLength: 48,
        excludePunctuation: true,
      },
    });

    this.dbSecurityGroup = new ec2.SecurityGroup(this, "DbSg", {
      vpc: props.vpc,
      description: "RDS access from services only",
      allowAllOutbound: true,
    });

    // Allow Postgres access from within the VPC only. RDS lives in isolated
    // subnets with no internet route, so scoping ingress to the VPC CIDR keeps
    // it private while avoiding cross-stack security-group references (which
    // would create CloudFormation dependency cycles between stacks).
    this.dbSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(props.vpc.vpcCidrBlock),
      ec2.Port.tcp(5432),
      "VPC clients to RDS"
    );

    this.db = new rds.DatabaseInstance(this, "Postgres", {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16,
      }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [this.dbSecurityGroup],
      multiAz: true,
      allocatedStorage: 20,
      maxAllocatedStorage: 100,
      databaseName: "personalize",
      credentials: rds.Credentials.fromGeneratedSecret("phadmin"),
      removalPolicy: RemovalPolicy.DESTROY,
      deleteAutomatedBackups: true,
      backupRetention: Duration.days(1),
    });

    this.dbSecret = this.db.secret!;
  }
}
