import { EventBridgeEvent } from "aws-lambda";
import {
  DeleteMessageBatchCommand,
  ReceiveMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import axios from "axios";

type ScheduledEvent = {};

const sqsClient = new SQSClient({ region: "us-east-1" });
const iterableClient = axios.create({
  baseURL: "https://api.iterable.com/api",
  headers: {
    "Api-Key": "YOUR_ITERABLE_API_KEY",
    "Content-Type": "application/json",
  },
});

export const handler = async (_event: EventBridgeEvent<ScheduledEvent>) => {
  const receiveMessageCommand = new ReceiveMessageCommand({
    QueueUrl: process.env.SQS_QUEUE_URL,
    MaxNumberOfMessages: 10,
    WaitTimeSeconds: 0,
  });

  let sqsResponse = await sqsClient.send(receiveMessageCommand);
  while (sqsResponse.Messages && sqsResponse.Messages?.length > 0) {
    const iterablePayload = mapEventsToIterablePayload(sqsResponse.Messages);

    // https://api.iterable.com/api/docs#events_trackBulk
    await iterableClient.post("/events/trackBulk", iterablePayload);

    const deleteMessageBatchCommand = new DeleteMessageBatchCommand({
      QueueUrl: process.env.SQS_QUEUE_URL,
      Entries: sqsResponse.Messages.map((message) => ({
        Id: message.MessageId,
        ReceiptHandle: message.ReceiptHandle,
      })),
    });
    await sqsClient.send(deleteMessageBatchCommand);

    sqsResponse = await sqsClient.send(receiveMessageCommand);
  }
};
