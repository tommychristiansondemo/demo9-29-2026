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
exports.CertificateStack = void 0;
const aws_cdk_lib_1 = require("aws-cdk-lib");
const acm = __importStar(require("aws-cdk-lib/aws-certificatemanager"));
const route53 = __importStar(require("aws-cdk-lib/aws-route53"));
const config_1 = require("./config");
/**
 * Provisions the ACM certificate for CloudFront. CloudFront requires the
 * certificate to live in us-east-1, so this stack is deployed to that region
 * and referenced cross-region by the edge stack.
 */
class CertificateStack extends aws_cdk_lib_1.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        const zone = route53.HostedZone.fromHostedZoneAttributes(this, "Zone", {
            hostedZoneId: config_1.CONFIG.hostedZoneId,
            zoneName: config_1.CONFIG.hostedZoneName,
        });
        this.certificate = new acm.Certificate(this, "CloudFrontCert", {
            domainName: config_1.CONFIG.domainName,
            validation: acm.CertificateValidation.fromDns(zone),
        });
    }
}
exports.CertificateStack = CertificateStack;
