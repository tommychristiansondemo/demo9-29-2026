import { Stack, StackProps, Duration } from "aws-cdk-lib";
import * as cw from "aws-cdk-lib/aws-cloudwatch";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as rds from "aws-cdk-lib/aws-rds";
import { Construct } from "constructs";

interface ObservabilityStackProps extends StackProps {
  alb: elbv2.ApplicationLoadBalancer;
  db: rds.DatabaseInstance;
}

export class ObservabilityStack extends Stack {
  constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
    super(scope, id, props);

    const alb5xx = props.alb.metrics.httpCodeElb(elbv2.HttpCodeElb.ELB_5XX_COUNT, {
      period: Duration.minutes(5),
    });

    new cw.Alarm(this, "Alb5xxAlarm", {
      metric: alb5xx,
      threshold: 10,
      evaluationPeriods: 1,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
    });

    new cw.Alarm(this, "RdsCpuAlarm", {
      metric: props.db.metricCPUUtilization({ period: Duration.minutes(5) }),
      threshold: 85,
      evaluationPeriods: 3,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
    });

    new cw.Alarm(this, "RdsConnectionsAlarm", {
      metric: props.db.metricDatabaseConnections({ period: Duration.minutes(5) }),
      threshold: 80,
      evaluationPeriods: 3,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
    });

    const dashboard = new cw.Dashboard(this, "Dashboard", {
      dashboardName: "PersonalizationHub",
    });

    dashboard.addWidgets(
      new cw.GraphWidget({
        title: "ALB Request Latency (p95)",
        left: [props.alb.metrics.targetResponseTime({ statistic: "p95" })],
      }),
      new cw.GraphWidget({
        title: "ALB 5xx",
        left: [alb5xx],
      }),
      new cw.GraphWidget({
        title: "RDS CPU / Connections",
        left: [props.db.metricCPUUtilization()],
        right: [props.db.metricDatabaseConnections()],
      }),
      new cw.GraphWidget({
        title: "Training Recall@K",
        left: [
          new cw.Metric({
            namespace: "PersonalizationHub/Training",
            metricName: "RecallAtK",
            period: Duration.hours(24),
          }),
        ],
      })
    );
  }
}
