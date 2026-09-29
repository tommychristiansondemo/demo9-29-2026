import { Duration, Stack, StackProps } from "aws-cdk-lib";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import { Construct } from "constructs";
import { CONFIG } from "./config";

interface EdgeStackProps extends StackProps {
  alb: elbv2.ApplicationLoadBalancer;
  certificate: acm.ICertificate; // us-east-1 cert (cross-region)
}

export class EdgeStack extends Stack {
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: EdgeStackProps) {
    super(scope, id, props);

    const zone = route53.HostedZone.fromHostedZoneAttributes(this, "Zone", {
      hostedZoneId: CONFIG.hostedZoneId,
      zoneName: CONFIG.hostedZoneName,
    });

    const origin = new origins.LoadBalancerV2Origin(props.alb, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
    });

    // API + auth: forward everything, no caching.
    const apiBehavior: cloudfront.BehaviorOptions = {
      origin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
    };

    this.distribution = new cloudfront.Distribution(this, "Distribution", {
      domainNames: [CONFIG.domainName],
      certificate: props.certificate,
      defaultBehavior: {
        origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        // SSR responses: forward cookies/headers, minimal caching.
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
      },
      additionalBehaviors: {
        "/api/*": apiBehavior,
        "/admin/*": apiBehavior,
        "/_next/static/*": {
          origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          // Forward the Host header so the ALB routes to the SSR service and
          // the origin serves the asset. Without this, /_next/static/* 502s
          // (the JS never loads, so the page is not interactive).
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
        },
      },
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
    });

    // Route 53 ALIAS: personalize.awsteach.com -> CloudFront.
    // NOTE: no record for www.awsteach.com is created anywhere.
    new route53.ARecord(this, "AliasA", {
      zone,
      recordName: "personalize",
      target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(this.distribution)),
      ttl: Duration.minutes(5),
    });

    new route53.AaaaRecord(this, "AliasAAAA", {
      zone,
      recordName: "personalize",
      target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(this.distribution)),
    });
  }
}
