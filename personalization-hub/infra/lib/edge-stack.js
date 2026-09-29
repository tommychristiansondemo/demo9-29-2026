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
exports.EdgeStack = void 0;
const aws_cdk_lib_1 = require("aws-cdk-lib");
const cloudfront = __importStar(require("aws-cdk-lib/aws-cloudfront"));
const origins = __importStar(require("aws-cdk-lib/aws-cloudfront-origins"));
const route53 = __importStar(require("aws-cdk-lib/aws-route53"));
const targets = __importStar(require("aws-cdk-lib/aws-route53-targets"));
const config_1 = require("./config");
class EdgeStack extends aws_cdk_lib_1.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        const zone = route53.HostedZone.fromHostedZoneAttributes(this, "Zone", {
            hostedZoneId: config_1.CONFIG.hostedZoneId,
            zoneName: config_1.CONFIG.hostedZoneName,
        });
        const origin = new origins.LoadBalancerV2Origin(props.alb, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
        });
        // API + auth: forward everything, no caching.
        const apiBehavior = {
            origin,
            viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
            cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
            originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
        };
        this.distribution = new cloudfront.Distribution(this, "Distribution", {
            domainNames: [config_1.CONFIG.domainName],
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
            ttl: aws_cdk_lib_1.Duration.minutes(5),
        });
        new route53.AaaaRecord(this, "AliasAAAA", {
            zone,
            recordName: "personalize",
            target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(this.distribution)),
        });
    }
}
exports.EdgeStack = EdgeStack;
