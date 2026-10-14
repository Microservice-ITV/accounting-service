import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import prisma from '../lib/prisma.js';
import { config } from '../config/index.js';
import {
  assertRecoveryEnvironment,
  recoverOrderPaidProjection,
} from '../infrastructure/rabbitmq/order-paid.recovery.js';

type RecoveryArguments = {
  eventFile: string;
  environment: string;
  expectedHost: string;
  expectedDatabase: string;
  eventId: string;
  orderId: string;
  paymentId: string;
  allowProduction: boolean;
};

function parseArguments(args: string[]): RecoveryArguments {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--allow-production') {
      flags.add(argument);
      continue;
    }
    if (!argument.startsWith('--') || !args[index + 1] || args[index + 1].startsWith('--')) {
      throw new Error(`Invalid recovery argument: ${argument}`);
    }
    values.set(argument, args[index + 1]);
    index += 1;
  }

  const required = [
    '--event-file',
    '--environment',
    '--expected-host',
    '--expected-database',
    '--event-id',
    '--order-id',
    '--payment-id',
  ] as const;
  const missing = required.filter((name) => !values.get(name));
  if (missing.length > 0) {
    throw new Error(`Missing required recovery arguments: ${missing.join(', ')}`);
  }
  const allowed = new Set([...required, '--allow-production']);
  for (const name of values.keys()) {
    if (!allowed.has(name as typeof required[number])) {
      throw new Error(`Unknown recovery argument: ${name}`);
    }
  }

  return {
    eventFile: values.get('--event-file')!,
    environment: values.get('--environment')!,
    expectedHost: values.get('--expected-host')!,
    expectedDatabase: values.get('--expected-database')!,
    eventId: values.get('--event-id')!,
    orderId: values.get('--order-id')!,
    paymentId: values.get('--payment-id')!,
    allowProduction: flags.has('--allow-production'),
  };
}

function logRecovery(
  eventId: string,
  orderId: string,
  paymentId: string,
  environment: string,
  outcome: string,
  extra: Record<string, unknown> = {},
): void {
  console.log(JSON.stringify({
    event_id: eventId,
    order_id: orderId,
    payment_id: paymentId,
    operation: 'order_paid_projection_recovery',
    environment,
    outcome,
    ...extra,
  }));
}

export async function runOrderPaidProjectionRecovery(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  let eventId = '';
  let orderId = '';
  let paymentId = '';
  let environment = '';
  try {
    const options = parseArguments(args);
    ({ eventId, orderId, paymentId, environment } = {
      eventId: options.eventId,
      orderId: options.orderId,
      paymentId: options.paymentId,
      environment: options.environment,
    });
    const databaseHost = new URL(config.databaseUrl).hostname;
    assertRecoveryEnvironment({
      requestedEnvironment: options.environment,
      configuredEnvironment: env.ACCOUNTING_RECOVERY_ENVIRONMENT,
      nodeEnvironment: env.NODE_ENV ?? config.nodeEnv,
      expectedHost: options.expectedHost,
      actualHost: databaseHost,
      expectedDatabase: options.expectedDatabase,
      allowProductionFlag: options.allowProduction,
      allowProductionEnvironmentVariable: env.ACCOUNTING_RECOVERY_ALLOW_PRODUCTION,
    });

    const eventPath = resolve(options.eventFile);
    const rawEvent: unknown = JSON.parse(await readFile(eventPath, 'utf8'));
    const [identity] = await prisma.$queryRaw<Array<{ database: string }>>`
      SELECT current_database() AS database
    `;
    assertRecoveryEnvironment({
      requestedEnvironment: options.environment,
      configuredEnvironment: env.ACCOUNTING_RECOVERY_ENVIRONMENT,
      nodeEnvironment: env.NODE_ENV ?? config.nodeEnv,
      expectedHost: options.expectedHost,
      actualHost: databaseHost,
      expectedDatabase: options.expectedDatabase,
      actualDatabase: identity?.database ?? '',
      allowProductionFlag: options.allowProduction,
      allowProductionEnvironmentVariable: env.ACCOUNTING_RECOVERY_ALLOW_PRODUCTION,
    });

    logRecovery(eventId, orderId, paymentId, environment, 'started');
    const result = await recoverOrderPaidProjection(rawEvent, {
      eventId,
      orderId,
      paymentId,
    });
    logRecovery(eventId, orderId, paymentId, environment, 'succeeded', result);
  } catch (error) {
    const errorType = error instanceof Error ? error.name : 'UnknownError';
    logRecovery(eventId, orderId, paymentId, environment, 'refused_or_failed', { error_type: errorType });
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runOrderPaidProjectionRecovery(process.argv.slice(2)).catch(() => {
    process.exitCode = 1;
  });
}
