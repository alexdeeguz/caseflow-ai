import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { buildApp } from '../app.js';
import { createDatabase } from '../database/index.js';
import { readLambdaConfig } from './config.js';
import { createLambdaProxy } from './adapter.js';

const secrets = new SecretsManagerClient({
  maxAttempts: 3,
  retryMode: 'standard',
  requestHandler: { connectionTimeout: 3000, requestTimeout: 5000, throwOnRequestTimeout: true },
});
const configurationLifetimeMs = 5 * 60 * 1000;
let application: Awaited<ReturnType<typeof initialize>> | undefined;

async function initialize() {
  const response = await secrets.send(
    new GetSecretValueCommand({ SecretId: process.env.API_SECRET_ARN }),
  );
  const config = readLambdaConfig(response.SecretString ?? '', process.env);
  const app = await buildApp(config, undefined, false, createDatabase(config.databaseUrl, 1));
  const proxy = createLambdaProxy(app);
  await app.ready();
  return { app, proxy, expiresAt: Date.now() + configurationLifetimeMs };
}

export async function handler(...args: Parameters<ReturnType<typeof createLambdaProxy>>) {
  try {
    if (application && application.expiresAt <= Date.now()) {
      const previous = application;
      application = undefined;
      await previous.app.close();
    }
    application ??= await initialize();
    return await application.proxy(...args);
  } catch {
    console.error(JSON.stringify({ event: 'api_lambda_unavailable' }));
    return {
      statusCode: 503,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({
        code: 'SERVICE_UNAVAILABLE',
        error: 'CaseFlow is temporarily unavailable. Please try again.',
      }),
      isBase64Encoded: false,
    };
  }
}
