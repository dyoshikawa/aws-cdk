import { PolicyStatement, Effect, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { App, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import { IntegTest, ExpectedResult, AssertionsProvider } from '@aws-cdk/integ-tests-alpha';
import { FlowLog, FlowLogDestination, FlowLogResourceType, Vpc, Instance, InstanceType, InstanceClass, InstanceSize, MachineImage, AmazonLinuxGeneration, CfnTransitGateway, IpAddresses, SubnetType, CfnTransitGatewayVpcAttachment } from 'aws-cdk-lib/aws-ec2';
import { EC2_RESTRICT_DEFAULT_SECURITY_GROUP } from 'aws-cdk-lib/cx-api';

const app = new App();

class FeatureFlagStack extends Stack {
  public readonly bucketArn: string;
  public readonly bucket: s3.IBucket;
  constructor(scope: App, id: string, props?: StackProps) {
    super(scope, id, props);

    this.node.setContext(EC2_RESTRICT_DEFAULT_SECURITY_GROUP, false);
    const vpc = new Vpc(this, 'VPC', { natGateways: 1 });

    const flowLog = vpc.addFlowLog('FlowLogsS3', {
      destination: FlowLogDestination.toS3(),
    });
    this.bucket = flowLog.bucket!;
    this.bucketArn = this.exportValue(flowLog.bucket!.bucketArn);

    vpc.addFlowLog('FlowLogsS3WithDestinationOptions', {
      destination: FlowLogDestination.toS3(undefined, undefined, {
        hiveCompatiblePartitions: true,
      }),
    });

    new Instance(this, 'FlowLogsInstance', {
      vpc,
      instanceType: InstanceType.of(InstanceClass.T3, InstanceSize.SMALL),
      machineImage: MachineImage.latestAmazonLinux({
        generation: AmazonLinuxGeneration.AMAZON_LINUX_2,
      }),
    });
  }
}

class DependencyTestStack extends Stack {
  constructor(scope: App, id: string, props?: StackProps) {
    super(scope, id, props);

    this.node.setContext(EC2_RESTRICT_DEFAULT_SECURITY_GROUP, false);
    const vpc = new Vpc(this, 'VPC', { natGateways: 1 });

    const bucket = new s3.Bucket(this, 'Bucket', {
      autoDeleteObjects: true,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    vpc.addFlowLog('FlowLogS3', {
      destination: FlowLogDestination.toS3(bucket, 'vpcFlowLog'),
    });
  }
}

class TestStack extends Stack {
  constructor(scope: App, id: string, props?: StackProps) {
    super(scope, id, props);

    this.node.setContext(EC2_RESTRICT_DEFAULT_SECURITY_GROUP, false);
    const vpc = new Vpc(this, 'VPC', { natGateways: 1 });

    new FlowLog(this, 'FlowLogsCW', {
      resourceType: FlowLogResourceType.fromVpc(vpc),
      flowLogName: 'CustomFlowLogName',
    });

    vpc.addFlowLog('FlowLogsS3', {
      destination: FlowLogDestination.toS3(),
    });

    const bucket = new s3.Bucket(this, 'Bucket', {
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    bucket.addToResourcePolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      principals: [new ServicePrincipal('delivery.logs.amazonaws.com')],
      actions: ['s3:PutObject'],
      resources: [bucket.arnForObjects(`AWSLogs/${this.account}/*`)],
      conditions: {
        StringEquals: {
          's3:x-amz-acl': 'bucket-owner-full-control',
          'aws:SourceAccount': this.account,
        },
        ArnLike: {
          'aws:SourceArn': this.formatArn({
            service: 'logs',
            resource: '*',
          }),
        },
      },
    }));
    bucket.addToResourcePolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      principals: [new ServicePrincipal('delivery.logs.amazonaws.com')],
      actions: ['s3:GetBucketAcl', 's3:ListBucket'],
      resources: [bucket.bucketArn],
      conditions: {
        StringEquals: {
          'aws:SourceAccount': this.account,
        },
        ArnLike: {
          'aws:SourceArn': this.formatArn({
            service: 'logs',
            resource: '*',
          }),
        },
      },
    }));

    vpc.addFlowLog('FlowLogsS3KeyPrefix', {
      destination: FlowLogDestination.toS3(bucket, 'prefix/'),
    });
  }
}

class TransitGatewayFlowLogStack extends Stack {
  public readonly flowLogId: string;

  constructor(scope: App, id: string, props?: StackProps) {
    super(scope, id, props);

    const transitGateway = new CfnTransitGateway(this, 'TransitGateway', {});
    const flowLog = new FlowLog(this, 'FlowLogsCW', {
      resourceType: FlowLogResourceType.fromTransitGatewayId(transitGateway.ref),
      flowLogName: 'TransitGatewayFlowLogName',
    });
    this.flowLogId = this.exportValue(flowLog.flowLogId);
  }
}

class TransitGatewayAttachmentFlowLogStack extends Stack {
  constructor(scope: App, id: string, props?: StackProps) {
    super(scope, id, props);

    const vpc = new Vpc(this, 'VpcForTransitGateway', {
      ipAddresses: IpAddresses.cidr('10.0.1.0/24'),
      natGateways: 0,
      maxAzs: 1,
      subnetConfiguration: [
        {
          name: 'IsolatedSubnet',
          subnetType: SubnetType.PRIVATE_ISOLATED,
        },
      ],
    });

    const transitGateway = new CfnTransitGateway(this, 'TransitGateway', {});
    const transitGatewayAttachment = new CfnTransitGatewayVpcAttachment(
      this,
      'TransitGatewayAttachment',
      {
        subnetIds: vpc.selectSubnets({
          subnetType: SubnetType.PRIVATE_ISOLATED,
        }).subnetIds,
        transitGatewayId: transitGateway.ref,
        vpcId: vpc.vpcId,
      },
    );

    new FlowLog(this, 'FlowLogFromTransitGatewayAttachment', {
      resourceType: FlowLogResourceType.fromTransitGatewayAttachmentId(transitGatewayAttachment.ref),
      flowLogName: 'TransitGatewayFlowLogName',
    });
  }
}

const featureFlagTest = new FeatureFlagStack(app, 'FlowLogsFeatureFlag');
const transitGatewayFlowLogTest = new TransitGatewayFlowLogStack(app, 'TransitGatewayFlowLogStack');
const transitGatewayAttachmentFlowLogTest = new TransitGatewayAttachmentFlowLogStack(app, 'TransitGatewayAttachmentFlowLogStack');

const integ = new IntegTest(app, 'FlowLogs', {
  testCases: [
    new TestStack(app, 'FlowLogsTestStack'),
    featureFlagTest,
    new DependencyTestStack(app, 'DependencyTestStack'),
    transitGatewayFlowLogTest,
    transitGatewayAttachmentFlowLogTest,
  ],
  diffAssets: true,
});

const objects = integ.assertions.awsApiCall('S3', 'listObjectsV2', {
  Bucket: featureFlagTest.bucket.bucketName,
  MaxKeys: 1,
  Prefix: `AWSLogs/${featureFlagTest.account}/vpcflowlogs`,
});
const assertionProvider = objects.node.tryFindChild('SdkProvider') as AssertionsProvider;
assertionProvider.addPolicyStatementFromSdkCall('s3', 'ListBucket', [featureFlagTest.bucketArn]);
assertionProvider.addPolicyStatementFromSdkCall('s3', 'GetObject', [`${featureFlagTest.bucketArn}/*`]);

objects.expect(ExpectedResult.objectLike({
  KeyCount: 1,
}));

app.synth();
