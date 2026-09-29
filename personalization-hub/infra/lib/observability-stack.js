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
exports.ObservabilityStack = void 0;
const aws_cdk_lib_1 = require("aws-cdk-lib");
const cw = __importStar(require("aws-cdk-lib/aws-cloudwatch"));
const elbv2 = __importStar(require("aws-cdk-lib/aws-elasticloadbalancingv2"));
class ObservabilityStack extends aws_cdk_lib_1.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        const alb5xx = props.alb.metrics.httpCodeElb(elbv2.HttpCodeElb.ELB_5XX_COUNT, {
            period: aws_cdk_lib_1.Duration.minutes(5),
        });
        new cw.Alarm(this, "Alb5xxAlarm", {
            metric: alb5xx,
            threshold: 10,
            evaluationPeriods: 1,
            comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
            treatMissingData: cw.TreatMissingData.NOT_BREACHING,
        });
        new cw.Alarm(this, "RdsCpuAlarm", {
            metric: props.db.metricCPUUtilization({ period: aws_cdk_lib_1.Duration.minutes(5) }),
            threshold: 85,
            evaluationPeriods: 3,
            comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
            treatMissingData: cw.TreatMissingData.NOT_BREACHING,
        });
        new cw.Alarm(this, "RdsConnectionsAlarm", {
            metric: props.db.metricDatabaseConnections({ period: aws_cdk_lib_1.Duration.minutes(5) }),
            threshold: 80,
            evaluationPeriods: 3,
            comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
            treatMissingData: cw.TreatMissingData.NOT_BREACHING,
        });
        const dashboard = new cw.Dashboard(this, "Dashboard", {
            dashboardName: "PersonalizationHub",
        });
        dashboard.addWidgets(new cw.GraphWidget({
            title: "ALB Request Latency (p95)",
            left: [props.alb.metrics.targetResponseTime({ statistic: "p95" })],
        }), new cw.GraphWidget({
            title: "ALB 5xx",
            left: [alb5xx],
        }), new cw.GraphWidget({
            title: "RDS CPU / Connections",
            left: [props.db.metricCPUUtilization()],
            right: [props.db.metricDatabaseConnections()],
        }), new cw.GraphWidget({
            title: "Training Recall@K",
            left: [
                new cw.Metric({
                    namespace: "PersonalizationHub/Training",
                    metricName: "RecallAtK",
                    period: aws_cdk_lib_1.Duration.hours(24),
                }),
            ],
        }));
    }
}
exports.ObservabilityStack = ObservabilityStack;
