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
exports.DataStack = void 0;
const aws_cdk_lib_1 = require("aws-cdk-lib");
const ec2 = __importStar(require("aws-cdk-lib/aws-ec2"));
const rds = __importStar(require("aws-cdk-lib/aws-rds"));
const s3 = __importStar(require("aws-cdk-lib/aws-s3"));
const secretsmanager = __importStar(require("aws-cdk-lib/aws-secretsmanager"));
class DataStack extends aws_cdk_lib_1.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        this.modelBucket = new s3.Bucket(this, "ModelBucket", {
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            encryption: s3.BucketEncryption.S3_MANAGED,
            removalPolicy: aws_cdk_lib_1.RemovalPolicy.DESTROY,
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
        this.dbSecurityGroup.addIngressRule(ec2.Peer.ipv4(props.vpc.vpcCidrBlock), ec2.Port.tcp(5432), "VPC clients to RDS");
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
            removalPolicy: aws_cdk_lib_1.RemovalPolicy.DESTROY,
            deleteAutomatedBackups: true,
            backupRetention: aws_cdk_lib_1.Duration.days(1),
        });
        this.dbSecret = this.db.secret;
    }
}
exports.DataStack = DataStack;
