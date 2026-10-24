import type { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma.js';
import { createJournalEntryInTransaction } from './services/entry.service.js';

type CodJournalContext = {
  orderId: string;
  shopId: string;
  amount: number;
  currency: string;
  shippingTotal?: number;
};

type CodCollectionAllocation = CodJournalContext & {
  paymentId: string;
};

export function buildCodRevenueRecognitionJournalLines(context: CodJournalContext) {
  const shippingTotal = context.shippingTotal ?? 0;
  const revenueAmount = context.amount - shippingTotal;
  return [
    {
      accountCode: '1200',
      direction: 'DEBIT' as const,
      amount: context.amount,
      currency: context.currency,
      shopId: context.shopId,
      memo: `COD receivable (${context.currency}; order=${context.orderId}, shop=${context.shopId})`,
    },
    ...(revenueAmount > 0 ? [{
      accountCode: '4000',
      direction: 'CREDIT' as const,
      amount: revenueAmount,
      currency: context.currency,
      shopId: context.shopId,
      memo: `COD sales revenue recognized on order confirmation (${context.currency}; order=${context.orderId}, shop=${context.shopId})`,
    }] : []),
    ...(shippingTotal > 0 ? [{
      accountCode: '2000',
      direction: 'CREDIT' as const,
      amount: shippingTotal,
      currency: context.currency,
      shopId: context.shopId,
      memo: `Delivery fee payable (${context.currency}; order=${context.orderId}, shop=${context.shopId})`,
    }] : []),
  ];
}

export function buildCodDeliveryCollectionJournalLines(context: CodJournalContext) {
  return [
    {
      accountCode: '1210',
      direction: 'DEBIT' as const,
      amount: context.amount,
      currency: context.currency,
      shopId: context.shopId,
      memo: `COD collected on delivery (${context.currency}; order=${context.orderId}, shop=${context.shopId})`,
    },
    {
      accountCode: '1200',
      direction: 'CREDIT' as const,
      amount: context.amount,
      currency: context.currency,
      shopId: context.shopId,
      memo: `COD receivable cleared on delivery (${context.currency}; order=${context.orderId}, shop=${context.shopId})`,
    },
  ];
}

export function buildCodBankReceiptJournalLines(context: CodJournalContext) {
  return [
    {
      accountCode: '1010',
      direction: 'DEBIT' as const,
      amount: context.amount,
      currency: context.currency,
      shopId: context.shopId,
      memo: `COD remittance received by bank (${context.currency}; order=${context.orderId}, shop=${context.shopId})`,
    },
    {
      accountCode: '1210',
      direction: 'CREDIT' as const,
      amount: context.amount,
      currency: context.currency,
      shopId: context.shopId,
      memo: `COD collection clearing settled to bank (${context.currency}; order=${context.orderId}, shop=${context.shopId})`,
    },
  ];
}

export function buildCodRevenueReferenceId(orderId: string, shopId: string) {
  return `${orderId}:${shopId}`;
}

export function buildCodDeliveryCollectionReferenceId(orderId: string, shopId: string) {
  return `${orderId}:${shopId}`;
}

export function buildCodBankReceiptReferenceId(paymentId: string, shopId: string) {
  return `${paymentId}:${shopId}`;
}

type TransactionDatabase = Pick<typeof prisma, '$transaction'>;
type JournalCreator = typeof createJournalEntryInTransaction;

export async function recordCodOrderRevenue(
  input: { orderId: string; shopId: string; eventId: string; entryDate: Date },
  database: TransactionDatabase = prisma,
  journalCreator: JournalCreator = createJournalEntryInTransaction,
): Promise<void> {
  await database.$transaction(async (tx) => {
    const projection = await tx.pnlOrderShop.findUnique({
      where: {
        orderId_shopId: {
          orderId: input.orderId,
          shopId: input.shopId,
        },
      },
    });
    if (!projection) {
      throw new Error(`Order sales projection missing for COD order ${input.orderId}, shop ${input.shopId}`);
    }
    if (!projection.paymentStatus) {
      throw new Error(`Order sales projection lacks payment status for order ${input.orderId}, shop ${input.shopId}`);
    }
    if (projection.paymentStatus !== 'COD') return;

    const paymentId = projection.paymentId;
    if (!paymentId || !projection.currency) {
      throw new Error(`COD order ${input.orderId}, shop ${input.shopId} has no payment or currency attribution`);
    }

    const referenceId = buildCodRevenueReferenceId(input.orderId, input.shopId);
    const existingRevenue = await tx.journalEntry.findUnique({
      where: {
        referenceType_referenceId: {
          referenceType: 'COD_REVENUE',
          referenceId,
        },
      },
      select: { id: true, status: true },
    });
    if (existingRevenue) {
      if (existingRevenue.status !== 'POSTED') {
        throw new Error(
          `Existing COD revenue journal is not posted for order ${input.orderId}, shop ${input.shopId}`,
        );
      }
      return;
    }

    const legacyPaymentEntry = await tx.journalEntry.findUnique({
      where: {
        referenceType_referenceId: {
          referenceType: 'PAYMENT',
          referenceId: paymentId,
        },
      },
      include: {
        lines: {
          include: { account: { select: { code: true } } },
        },
      },
    });
    if (legacyPaymentEntry?.lines.some(
      (line) => line.account.code === '4000' && line.direction === 'CREDIT',
    )) {
      console.warn(
        `Skipping COD revenue recognition for ${paymentId}; a legacy payment revenue journal is already posted.`,
      );
      return;
    }

    const amount = Number(projection.paidAmount.toString());
    const shippingTotal = Number(projection.shippingTotal.toString());
    if (
      !Number.isFinite(amount)
      || !Number.isFinite(shippingTotal)
      || amount <= 0
      || shippingTotal < 0
      || shippingTotal > amount
    ) {
      throw new Error(`COD order ${input.orderId}, shop ${input.shopId} has invalid payable or shipping amounts`);
    }

    await journalCreator({
      referenceType: 'COD_REVENUE',
      referenceId,
      eventId: `order.paid:cod-revenue:${input.orderId}:${input.shopId}:${input.eventId}`,
      narration: `COD revenue recognized for order ${input.orderId}, shop ${input.shopId}`,
      entryDate: input.entryDate,
      lines: buildCodRevenueRecognitionJournalLines({
        ...input,
        amount,
        currency: projection.currency,
        shippingTotal,
      }),
    }, tx);
  });
}

function cents(value: { toString(): string } | number): number {
  return Math.round(Number(value.toString()) * 100);
}

function isMatchingCodJournal(
  journal: {
    status: string;
    lines: Array<{
      account: { code: string };
      direction: string;
      amount: { toString(): string };
      currency: string | null;
      shopId: string | null;
    }>;
  },
  debitCode: string,
  creditCode: string,
  amount: number,
  currency: string,
  shopId: string,
): boolean {
  const debits = journal.lines.filter(
    (line) => line.account.code === debitCode && line.direction === 'DEBIT',
  );
  const credits = journal.lines.filter(
    (line) => line.account.code === creditCode && line.direction === 'CREDIT',
  );
  return journal.status === 'POSTED'
    && journal.lines.length === 2
    && debits.length === 1
    && credits.length === 1
    && cents(debits[0]!.amount) === Math.round(amount * 100)
    && cents(credits[0]!.amount) === Math.round(amount * 100)
    && journal.lines.every((line) => line.currency === currency && line.shopId === shopId);
}

function isMatchingCodRevenueJournal(
  journal: {
    status: string;
    lines: Array<{
      account: { code: string };
      direction: string;
      amount: { toString(): string };
      currency: string | null;
      shopId: string | null;
    }>;
  },
  amount: number,
  shippingTotal: number,
  currency: string,
  shopId: string,
): boolean {
  const receivable = journal.lines.filter(
    (line) => line.account.code === '1200' && line.direction === 'DEBIT',
  );
  const revenue = journal.lines.filter(
    (line) => line.account.code === '4000' && line.direction === 'CREDIT',
  );
  const deliveryFee = journal.lines.filter(
    (line) => line.account.code === '2000' && line.direction === 'CREDIT',
  );
  const expectedRevenue = Math.max(0, amount - shippingTotal);
  const isLegacyRevenue = journal.lines.length === 2
    && revenue.length === 1
    && cents(revenue[0]!.amount) === Math.round(amount * 100)
    && deliveryFee.length === 0;
  const isNetRevenue = journal.lines.length === 1 + (expectedRevenue > 0 ? 1 : 0) + (shippingTotal > 0 ? 1 : 0)
    && revenue.length === (expectedRevenue > 0 ? 1 : 0)
    && deliveryFee.length === (shippingTotal > 0 ? 1 : 0)
    && (expectedRevenue === 0 || cents(revenue[0]!.amount) === Math.round(expectedRevenue * 100))
    && (shippingTotal === 0 || cents(deliveryFee[0]!.amount) === Math.round(shippingTotal * 100));

  return journal.status === 'POSTED'
    && (isLegacyRevenue || isNetRevenue)
    && receivable.length === 1
    && cents(receivable[0]!.amount) === Math.round(amount * 100)
    && journal.lines.every((line) => line.currency === currency && line.shopId === shopId);
}

async function findLegacyCollection(
  tx: Prisma.TransactionClient,
  paymentId: string,
  shopId: string,
  amount: number,
  currency: string,
) {
  const entries = await tx.journalEntry.findMany({
    where: {
      referenceType: 'COD_COLLECTION',
      referenceId: { startsWith: `${paymentId}:${shopId}:` },
      status: 'POSTED',
    },
    include: {
      lines: { include: { account: { select: { code: true } } } },
    },
  });
  const matching = entries.filter((entry) =>
    isMatchingCodJournal(entry, '1210', '1200', amount, currency, shopId),
  );
  if (matching.length > 1) {
    throw new Error(`Multiple legacy COD collection journals exist for payment ${paymentId}, shop ${shopId}`);
  }
  return matching[0] ?? null;
}

export async function recordCodDeliveryCollectionJournal(
  input: { orderId: string; shopId: string; eventId: string; entryDate: Date },
  database: TransactionDatabase = prisma,
  journalCreator: JournalCreator = createJournalEntryInTransaction,
): Promise<void> {
  await database.$transaction(async (tx) => {
    const projection = await tx.pnlOrderShop.findUnique({
      where: { orderId_shopId: { orderId: input.orderId, shopId: input.shopId } },
    });
    if (!projection) {
      throw new Error(`Order sales projection missing for delivered COD order ${input.orderId}, shop ${input.shopId}`);
    }
    if (!projection.paymentStatus) {
      throw new Error(`Order sales projection lacks payment status for delivered order ${input.orderId}, shop ${input.shopId}`);
    }
    if (projection.paymentStatus !== 'COD') return;
    if (!projection.paymentId || !projection.currency) {
      throw new Error(`COD order ${input.orderId}, shop ${input.shopId} has no payment or currency attribution`);
    }

    const amount = Number(projection.paidAmount.toString());
    const shippingTotal = Number(projection.shippingTotal.toString());
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error(`COD order ${input.orderId}, shop ${input.shopId} has an invalid payable amount`);
    }
    if (!Number.isFinite(shippingTotal) || shippingTotal < 0 || shippingTotal > amount) {
      throw new Error(`COD order ${input.orderId}, shop ${input.shopId} has an invalid shipping amount`);
    }

    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(
        hashtext('accounting.cod-delivery-collection'),
        hashtext(${`${input.orderId}:${input.shopId}`})
      )
    `;

    const revenue = await tx.journalEntry.findUnique({
      where: {
        referenceType_referenceId: {
          referenceType: 'COD_REVENUE',
          referenceId: buildCodRevenueReferenceId(input.orderId, input.shopId),
        },
      },
      include: { lines: { include: { account: { select: { code: true } } } } },
    });
    if (!revenue || !isMatchingCodRevenueJournal(
      revenue,
      amount,
      shippingTotal,
      projection.currency,
      input.shopId,
    )) {
      throw new Error(`COD revenue journal missing or inconsistent for delivered order ${input.orderId}, shop ${input.shopId}`);
    }

    const referenceId = buildCodDeliveryCollectionReferenceId(input.orderId, input.shopId);
    const existing = await tx.journalEntry.findUnique({
      where: {
        referenceType_referenceId: {
          referenceType: 'COD_DELIVERY_COLLECTION',
          referenceId,
        },
      },
      include: { lines: { include: { account: { select: { code: true } } } } },
    });
    if (existing) {
      if (!isMatchingCodJournal(existing, '1210', '1200', amount, projection.currency, input.shopId)) {
        throw new Error(`Existing COD delivery journal conflicts with order ${input.orderId}, shop ${input.shopId}`);
      }
      return;
    }

    const legacyCollection = await findLegacyCollection(
      tx,
      projection.paymentId,
      input.shopId,
      amount,
      projection.currency,
    );
    if (legacyCollection) return;

    await journalCreator({
      referenceType: 'COD_DELIVERY_COLLECTION',
      referenceId,
      eventId: `shipment.delivered:cod-collection:${input.orderId}:${input.shopId}`,
      narration: `COD collected on delivery for order ${input.orderId}, shop ${input.shopId}`,
      entryDate: input.entryDate,
      lines: buildCodDeliveryCollectionJournalLines({
        orderId: input.orderId,
        shopId: input.shopId,
        amount,
        currency: projection.currency,
      }),
    }, tx);
  });
}

export async function recordCodBankReceiptJournals(
  allocations: CodCollectionAllocation[],
  eventId: string,
  database: TransactionDatabase = prisma,
  journalCreator: JournalCreator = createJournalEntryInTransaction,
): Promise<void> {
  await database.$transaction(async (tx) => {
    const posts: Array<{ allocation: CodCollectionAllocation; referenceId: string }> = [];
    for (const allocation of allocations) {
      if (!Number.isFinite(allocation.amount) || allocation.amount <= 0) {
        throw new Error('COD bank receipt amount must be greater than zero');
      }
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(
          hashtext('accounting.cod-bank-receipt'),
          hashtext(${`${allocation.paymentId}:${allocation.shopId}`})
        )
      `;
      const projection = await tx.pnlOrderShop.findUnique({
        where: { orderId_shopId: { orderId: allocation.orderId, shopId: allocation.shopId } },
      });
      if (!projection) {
        throw new Error(`Order sales projection missing for COD bank receipt ${allocation.orderId}, shop ${allocation.shopId}`);
      }
      if (
        projection.paymentStatus !== 'COD'
        || projection.paymentId !== allocation.paymentId
        || projection.currency !== allocation.currency
      ) {
        throw new Error(`COD bank receipt payment, shop, or currency attribution conflicts with order ${allocation.orderId}, shop ${allocation.shopId}`);
      }
      const projectedAmount = Number(projection.paidAmount.toString());
      if (Math.round(projectedAmount * 100) !== Math.round(allocation.amount * 100)) {
        throw new Error(`COD bank receipt amount does not match the full order shop amount for order ${allocation.orderId}, shop ${allocation.shopId}`);
      }

      const deliveryReferenceId = buildCodDeliveryCollectionReferenceId(allocation.orderId, allocation.shopId);
      const deliveryEntry = await tx.journalEntry.findUnique({
        where: {
          referenceType_referenceId: {
            referenceType: 'COD_DELIVERY_COLLECTION',
            referenceId: deliveryReferenceId,
          },
        },
        include: {
          lines: {
            include: { account: { select: { code: true } } },
          },
        },
      });
      const legacyCollection = deliveryEntry ? null : await findLegacyCollection(
        tx,
        allocation.paymentId,
        allocation.shopId,
        projectedAmount,
        allocation.currency,
      );
      if (
        (!deliveryEntry || !isMatchingCodJournal(
          deliveryEntry,
          '1210',
          '1200',
          projectedAmount,
          allocation.currency,
          allocation.shopId,
        ))
        && !legacyCollection
      ) {
        throw new Error(`COD bank receipt arrived before delivery collection for order ${allocation.orderId}, shop ${allocation.shopId}`);
      }

      const referenceId = buildCodBankReceiptReferenceId(allocation.paymentId, allocation.shopId);
      const existingReceipt = await tx.journalEntry.findUnique({
        where: {
          referenceType_referenceId: {
            referenceType: 'COD_BANK_RECEIPT',
            referenceId,
          },
        },
        include: {
          lines: {
            include: { account: { select: { code: true } } },
          },
        },
      });
      if (existingReceipt) {
        if (!isMatchingCodJournal(
          existingReceipt,
          '1010',
          '1210',
          allocation.amount,
          allocation.currency,
          allocation.shopId,
        )) {
          throw new Error(`Existing COD bank receipt conflicts with payment ${allocation.paymentId}, shop ${allocation.shopId}`);
        }
        continue;
      }
      const requestedCents = Math.round(allocation.amount * 100);
      if (requestedCents !== Math.round(projectedAmount * 100)) {
        throw new Error(`COD bank receipt amount does not match full collected amount for payment ${allocation.paymentId}, shop ${allocation.shopId}`);
      }

      posts.push({
        allocation,
        referenceId,
      });
    }

    for (const { allocation, referenceId } of posts) {
      await journalCreator({
        referenceType: 'COD_BANK_RECEIPT',
        referenceId,
        eventId: `payment.collected:cod-bank-receipt:${allocation.paymentId}:${allocation.shopId}`,
        narration: `COD bank receipt for order ${allocation.orderId}, shop ${allocation.shopId}`,
        lines: buildCodBankReceiptJournalLines(allocation),
      }, tx);
    }
  });
}
