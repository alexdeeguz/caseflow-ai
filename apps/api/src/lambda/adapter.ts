import awsLambdaFastify from '@fastify/aws-lambda';
import type { FastifyInstance } from 'fastify';

export function createLambdaProxy(app: FastifyInstance) {
  return awsLambdaFastify(app, {
    decorateRequest: false,
    serializeLambdaArguments: false,
    callbackWaitsForEmptyEventLoop: false,
    parseCommaSeparatedQueryParams: false,
  });
}
