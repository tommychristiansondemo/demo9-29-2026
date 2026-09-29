import { Stack, StackProps } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as route53 from "aws-cdk-lib/aws-route53";
import { Construct } from "constructs";
import { CONFIG } from "./config";

/**
 * Provisions the ACM certificate for CloudFront. CloudFront requires the
 * certificate to live in us-east-1, so this stack is deployed to that region
 * and referenced cross-region by the edge stack.
 */
export class CertificateStack extends Stack {
  public readonly certificate: acm.Certificate;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const zone = route53.HostedZone.fromHostedZoneAttributes(this, "Zone", {
      hostedZoneId: CONFIG.hostedZoneId,
      zoneName: CONFIG.hostedZoneName,
    });

    this.certificate = new acm.Certificate(this, "CloudFrontCert", {
      domainName: CONFIG.domainName,
      validation: acm.CertificateValidation.fromDns(zone),
    });
  }
}
