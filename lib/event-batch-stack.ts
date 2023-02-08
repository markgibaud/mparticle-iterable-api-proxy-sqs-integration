import * as cdk from "aws-cdk-lib";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as apigw from "aws-cdk-lib/aws-apigateway";
import * as iam from "aws-cdk-lib/aws-iam";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as events from "aws-cdk-lib/aws-events";
import { Construct } from "constructs";
import { Duration } from "aws-cdk-lib";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Architecture, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";

export class EventBatchStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // New SQS queue
    const sqsQueue = new sqs.Queue(this, `${id}-events-queue`, {
      queueName: `${id}-queue`,
      visibilityTimeout: Duration.seconds(30),
      retentionPeriod: Duration.days(4),
      receiveMessageWaitTime: Duration.seconds(0),
      deadLetterQueue: {
        queue: new sqs.Queue(this, `${id}-events-dlq`),
        maxReceiveCount: 3,
      },
    });

    // Rest API
    const restApi = new apigw.RestApi(this, `${id}-gateway`, {
      restApiName: `${id}-gateway`,
      description: "API Gateway for mParticle Iterable API Proxy",
      cloudWatchRole: true,
      deployOptions: {
        stageName: "dev",
      },
    });

    // Event batch Rest API resource
    const eventBatchResource = restApi.root.addResource("event-batch");

    // Yes it's IAM again :-)
    const gatewayServiceRole = new iam.Role(this, "api-gateway-role", {
      assumedBy: new iam.ServicePrincipal("apigateway.amazonaws.com"),
    });

    // This allows API Gateway to send our event body to our specific queue
    gatewayServiceRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        resources: [sqsQueue.queueArn],
        actions: ["sqs:SendMessage"],
      })
    );

    // A request template that tells API Gateway what action (SendMessage) to apply to what part of the payload (Body)
    const requestTemplate =
      'Action=SendMessage&MessageBody=$util.urlEncode("$input.body")';

    const AWS_ACCOUNT_ID = "XXX";
    const awsIntegrationProps: apigw.AwsIntegrationProps = {
      service: "sqs",
      integrationHttpMethod: "POST",
      // Path is where we specify the sqs queue to send to, in the format {account_id}/{queue_name}
      path: `${AWS_ACCOUNT_ID}/${sqsQueue.queueName}`,
      options: {
        passthroughBehavior: apigw.PassthroughBehavior.NEVER,
        credentialsRole: gatewayServiceRole,
        requestParameters: {
          // API Gateway needs to send messages to SQS using content type form-urlencoded
          "integration.request.header.Content-Type": `'application/x-www-form-urlencoded'`,
        },
        requestTemplates: {
          "application/json": requestTemplate,
        },
        integrationResponses: [
          {
            statusCode: "200",
            responseTemplates: {
              "application/json": `{"successful": true}`,
            },
          },
          {
            statusCode: "500",
            responseTemplates: {
              "text/html": "Error",
            },
            selectionPattern: "500",
          },
        ],
      },
    };

    eventBatchResource.addMethod(
      "POST",
      new apigw.AwsIntegration(awsIntegrationProps),
      { methodResponses: [{ statusCode: "200" }] }
    );

    // event forwarder lambda
    const forwarder = new NodejsFunction(this, `${id}-forwarder`, {
      runtime: Runtime.NODEJS_16_X,
      functionName: `${id}-event-forwarder`,
      entry: "src/functions/forwarder/forwarder.ts",
      handler: "handler",
      memorySize: 512,
      timeout: Duration.seconds(30),
      architecture: Architecture.ARM_64,
      environment: {
        SQS_QUEUE_URL: sqsQueue.queueUrl,
      },
      initialPolicy: [
        new PolicyStatement({
          actions: ["sqs:ReceiveMessage", "sqs:DeleteMessageBatch"],
          resources: [sqsQueue.queueArn],
        }),
      ],
    });

    const lambdaTarget = new targets.LambdaFunction(forwarder);
    new events.Rule(this, "ForwarderScheduleRule", {
      description: "Forward stored mParticle events to Iterable every hour",
      schedule: events.Schedule.rate(Duration.minutes(5)),
      targets: [lambdaTarget],
      // omitting the eventBus property puts the rule on the default event bus
    });
  }
}
