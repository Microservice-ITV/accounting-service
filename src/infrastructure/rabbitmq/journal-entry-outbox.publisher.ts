import { Channel, ChannelModel, ConfirmChannel, connect } from 'amqplib';
import prisma from '../../lib/prisma.js';
import { config } from '../../config/index.js';
import { buildJournalEntryUpsertEvent } from '../../modules/entries/entry.service.js';

const EVENT_BATCH_SIZE = 100;
const PUBLISH_INTERVAL_MS = 1_000;
const SNAPSHOT_EVENT_PREFIX = 'accounting.journal-entry.snapshot:';

let connection: ChannelModel | null = null;
let channel: ConfirmChannel | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let activePublish: Promise<void> | null = null;
let snapshotsQueued = false;

const logError = (message: string, error: unknown): void => {
  console.error(message, error);
};

const isMissingTableError = (error: unknown, modelName: string): boolean => {
  const prismaError = error as { code?: string; meta?: { modelName?: string; table?: string } };
  return (
    prismaError?.code === 'P2021' &&
    (
      prismaError?.meta?.modelName === modelName ||
      prismaError?.meta?.table === `public.${modelName}` ||
      prismaError?.meta?.table === modelName
    )
  );
};

const getConfirmChannel = async (): Promise<ConfirmChannel> => {
  if (channel) return channel;

  const nextConnection = await connect(config.rabbitmqUrl);
  nextConnection.on('error', (error) => logError('Accounting event publisher RabbitMQ error', error));
  nextConnection.on('close', () => {
    connection = null;
    channel = null;
  });

  let nextChannel: ConfirmChannel;
  try {
    nextChannel = await nextConnection.createConfirmChannel();
    await nextChannel.assertExchange(config.accountingEventsExchange, 'topic', {
      durable: true,
    });
    nextChannel.on('error', (error) => logError('Accounting event publisher channel error', error));
  } catch (error) {
    await nextConnection.close().catch((closeError: unknown) => {
      logError('Failed to close accounting event publisher connection', closeError);
    });
    throw error;
  }

  connection = nextConnection;
  channel = nextChannel;
  return nextChannel;
};

const queueExistingEntrySnapshots = async (): Promise<void> => {
  let cursor: string | undefined;

  while (true) {
    let entries;
    try {
      entries = await prisma.journalEntry.findMany({
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        take: EVENT_BATCH_SIZE,
        orderBy: { id: 'asc' },
        include: {
          lines: {
            include: {
              account: {
                select: {
                  id: true,
                  code: true,
                  name: true,
                  type: true,
                },
              },
            },
          },
        },
      });
    } catch (error) {
      const prismaError = error as { code?: string; meta?: { modelName?: string; table?: string } };
      if (prismaError?.code === 'P2021' && prismaError?.meta?.modelName === 'JournalEntry') {
        console.warn('JournalEntry table not found; skipping outbox snapshot backfill until migrations complete.');
        return;
      }
      throw error;
    }

    if (entries.length === 0) return;

    await prisma.accountingOutboxEvent.createMany({
      data: entries.map((entry) => {
        const event = buildJournalEntryUpsertEvent(
          entry,
          `${SNAPSHOT_EVENT_PREFIX}${entry.id}`,
        );
        return {
          eventId: event.eventId,
          eventType: event.eventType,
          routingKey: event.routingKey,
          payload: event.payload,
        };
      }),
      skipDuplicates: true,
    });

    cursor = entries[entries.length - 1].id;
  }
};

const publishPendingEvents = async (): Promise<void> => {
  try {
    if (!snapshotsQueued) {
      await queueExistingEntrySnapshots();
      snapshotsQueued = true;
    }

    const pendingEvents = await prisma.accountingOutboxEvent.findMany({
      where: { publishedAt: null },
      orderBy: { createdAt: 'asc' },
      take: EVENT_BATCH_SIZE,
    });
    if (pendingEvents.length === 0) return;

    const publisher = await getConfirmChannel();
    for (const event of pendingEvents) {
      publisher.publish(
        config.accountingEventsExchange,
        event.routingKey,
        Buffer.from(JSON.stringify(event.payload)),
        { persistent: true, contentType: 'application/json' },
      );
      await publisher.waitForConfirms();
      await prisma.accountingOutboxEvent.update({
        where: { id: event.id },
        data: { publishedAt: new Date() },
      });
    }
  } catch (error) {
    logError('Failed to publish accounting journal-entry outbox events', error);
    channel = null;
    const previousConnection = connection;
    connection = null;
    if (previousConnection) {
      await previousConnection.close().catch((closeError: unknown) => {
        logError('Failed to close accounting event publisher connection', closeError);
      });
    }
  }
};

const runPublishCycle = (): Promise<void> => {
  if (activePublish) return activePublish;
  activePublish = publishPendingEvents().finally(() => {
    activePublish = null;
  });
  return activePublish;
};

export const startJournalEntryOutboxPublisher = (): void => {
  if (timer) return;
  void runPublishCycle();
  timer = setInterval(() => void runPublishCycle(), PUBLISH_INTERVAL_MS);
};

export const closeJournalEntryOutboxPublisher = async (): Promise<void> => {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  await activePublish;

  const activeChannel: Channel | null = channel;
  const activeConnection = connection;
  channel = null;
  connection = null;

  await Promise.all([
    activeChannel?.close().catch((error: unknown) => {
      logError('Failed to close accounting event publisher channel', error);
    }),
    activeConnection?.close().catch((error: unknown) => {
      logError('Failed to close accounting event publisher connection', error);
    }),
  ]);
};
