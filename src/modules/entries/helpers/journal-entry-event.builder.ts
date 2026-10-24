import type { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { config } from '../../../config/index.js';

type JournalEntryProjection = Prisma.JournalEntryGetPayload<{
  include: {
    lines: {
      include: {
        account: {
          select: {
            id: true;
            code: true;
            name: true;
            type: true;
          };
        };
      };
    };
  };
}>;

export function buildJournalEntryUpsertEvent(
  entry: JournalEntryProjection,
  eventId: string = randomUUID(),
) {
  return {
    eventId,
    eventType: 'accounting.journal-entry.upserted',
    routingKey: config.accountingJournalEntryRoutingKey,
    payload: {
      event_id: eventId,
      event: 'accounting.journal-entry.upserted',
      timestamp: new Date().toISOString(),
      data: {
        id: entry.id,
        referenceType: entry.referenceType,
        referenceId: entry.referenceId,
        eventId: entry.eventId,
        narration: entry.narration,
        entryDate: entry.entryDate.toISOString(),
        status: entry.status,
        version: entry.version,
        createdAt: entry.createdAt.toISOString(),
        lines: entry.lines.map((line) => ({
          id: line.id,
          direction: line.direction,
          amount: Number(line.amount),
          currency: line.currency,
          shopId: line.shopId,
          memo: line.memo,
          account: line.account,
        })),
      },
    } satisfies Prisma.InputJsonValue,
  };
}
