import type { Channel, ChannelModel, ConsumeMessage } from 'amqplib';
import { connect } from 'amqplib';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import prisma from '../../lib/prisma.js';
import { createJournalEntryInTransaction } from '../../modules/entries/entry.service.js';
import { ExpenseRepository } from '../../modules/expenses/repositories/expense.repository.js';
import { config } from '../../config/index.js';

const shipmentDeliveredSchema = z.object({
  event_id: z.string().min(1),
  event: z.literal('shipment.delivered'),
  timestamp: z.string().optional(),
  data: z.object({
    order_id: z.string().min(1),
    deliveryCompanyId: z.string().min(1),
    shopId: z.string().min(1).nullish(),
    delivery: z.object({
      deliveryId: z.string().min(1),
      deliveryNumber: z.string().min(1),
      deliveryCompanyId: z.string().min(1),
      shopId: z.string().min(1).nullish(),
      courier: z.object({
        code: z.string().nullish(),
        name: z.string().nullish(),
      }).passthrough(),
      status: z.literal('DELIVERED'),
      timeline: z.object({
        deliveredAt: z.string().min(1),
      }).passthrough(),
      items: z.array(z.object({
        shopId: z.string().nullish(),
      }).passthrough()).optional(),
    }).passthrough(),
  }).passthrough(),
}).passthrough();

export type ShipmentDeliveredEvent = z.infer<typeof shipmentDeliveredSchema>;

export function normalizeShipmentDeliveredEvent(raw: unknown): ShipmentDeliveredEvent {
  return shipmentDeliveredSchema.parse(raw);
}

export class PermanentShipmentDeliveredEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentShipmentDeliveredEventError';
  }
}

export type DeliveryExpenseInput = {
  orderId: string;
  deliveryId: string;
  deliveryNumber: string;
  deliveryCompanyId: string;
  shopId: string;
  expenseDate: Date;
  description: string;
  deliveryExpenseGroupId?: string;
};

export function buildShipmentDeliveredExpense(event: ShipmentDeliveredEvent): DeliveryExpenseInput {
  const delivery = event.data.delivery;
  if (delivery.deliveryCompanyId !== event.data.deliveryCompanyId) {
    throw new PermanentShipmentDeliveredEventError(
      `shipment.delivered for delivery ${delivery.deliveryId} contains conflicting Delivery Company IDs`,
    );
  }
  const deliveredAt = new Date(delivery.timeline.deliveredAt);
  if (Number.isNaN(deliveredAt.getTime())) {
    throw new PermanentShipmentDeliveredEventError(
      `shipment.delivered for delivery ${delivery.deliveryId} has an invalid data.delivery.timeline.deliveredAt`
    );
  }

  const items = delivery.items ?? [];
  const shopIds = items.map((item) => item.shopId?.trim() ?? '');
  const declaredShopId = event.data.shopId?.trim() || delivery.shopId?.trim() || '';
  if (shopIds.some((shopId) => !shopId) && !declaredShopId) {
    throw new PermanentShipmentDeliveredEventError(
      `shipment.delivered for delivery ${delivery.deliveryId} has no complete item shop attribution`
    );
  }

  const distinctShopIds = [...new Set(shopIds.filter(Boolean))];
  if (distinctShopIds.length > 1 || (declaredShopId && distinctShopIds.some((shopId) => shopId !== declaredShopId))) {
    throw new PermanentShipmentDeliveredEventError(
      `shipment.delivered for delivery ${delivery.deliveryId} contains multiple shops; refusing to allocate one delivery fee`
    );
  }

  const shopId = declaredShopId || distinctShopIds[0];
  if (!shopId) {
    throw new PermanentShipmentDeliveredEventError(
      `shipment.delivered for delivery ${delivery.deliveryId} has no shop attribution`
    );
  }
  const description = `Delivery expense for delivery ${delivery.deliveryNumber}, order ${event.data.order_id}`;

  return {
    orderId: event.data.order_id,
    deliveryId: delivery.deliveryId,
    deliveryNumber: delivery.deliveryNumber,
    deliveryCompanyId: event.data.deliveryCompanyId,
    shopId,
    expenseDate: deliveredAt,
    description,
  };
}

type DeliveryFeeCandidate = Pick<
  Prisma.DeliveryCompanyFeeGetPayload<{}>,
  'id' | 'chargingBasis' | 'amount' | 'currency' | 'active' | 'effectiveFrom' | 'effectiveTo' | 'createdAt'
>;

export function selectApplicableDeliveryFee(
  fees: DeliveryFeeCandidate[],
  effectiveAt: Date,
): DeliveryFeeCandidate | null {
  const applicableFees = fees
    .filter((fee) =>
      fee.active
      && (!fee.effectiveFrom || fee.effectiveFrom <= effectiveAt)
      && (!fee.effectiveTo || effectiveAt < fee.effectiveTo)
    )
    .sort((left, right) => {
      const leftStart = left.effectiveFrom?.getTime() ?? Number.NEGATIVE_INFINITY;
      const rightStart = right.effectiveFrom?.getTime() ?? Number.NEGATIVE_INFINITY;
      return rightStart > leftStart ? 1 : rightStart < leftStart ? -1 : 0;
    });

  const selected = applicableFees[0];
  if (!selected) return null;

  const selectedStart = selected.effectiveFrom?.getTime() ?? Number.NEGATIVE_INFINITY;
  const nextFee = applicableFees[1];
  if (nextFee && (nextFee.effectiveFrom?.getTime() ?? Number.NEGATIVE_INFINITY) === selectedStart) {
    throw new Error(`Multiple active delivery fees share the latest effective date`);
  }

  return selected;
}

export function buildDeliveryExpenseReference(
  chargingBasis: 'PER_ORDER' | 'PER_INVOICE',
  input: Pick<DeliveryExpenseInput, 'deliveryCompanyId' | 'shopId' | 'orderId' | 'deliveryExpenseGroupId'>,
): string {
  if (!input.deliveryCompanyId) {
    throw new PermanentShipmentDeliveredEventError('Delivery Company ID is required for a canonical expense reference');
  }
  const chargeKey = chargingBasis === 'PER_ORDER'
    ? [input.shopId, input.deliveryCompanyId, input.orderId]
    : input.deliveryExpenseGroupId
      ? [input.shopId, input.deliveryCompanyId, input.deliveryExpenseGroupId]
      : null;
  if (!chargeKey) {
    throw new PermanentShipmentDeliveredEventError('Delivery expense group ID is required for PER_INVOICE charging');
  }
  const digest = createHash('sha256').update(JSON.stringify(chargeKey)).digest('hex');
  return `DELI-${chargingBasis === 'PER_ORDER' ? 'ORDER' : 'INVOICE'}-${digest}`;
}

function getCandidateDeliveryExpenseReferences(input: DeliveryExpenseInput): string[] {
  return [
    `DELI-${input.deliveryId}`,
    buildDeliveryExpenseReference('PER_ORDER', input),
    ...(input.deliveryExpenseGroupId
      ? [buildDeliveryExpenseReference('PER_INVOICE', input)]
      : []),
  ];
}

async function findApplicableDeliveryFee(
  transaction: Prisma.TransactionClient,
  input: DeliveryExpenseInput,
  effectiveAt: Date,
) {
  const fees = await transaction.deliveryCompanyFee.findMany({
    where: {
      shopId: input.shopId,
      deliveryCompanyId: input.deliveryCompanyId,
      active: true,
      AND: [
        { OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: effectiveAt } }] },
        { OR: [{ effectiveTo: null }, { effectiveTo: { gt: effectiveAt } }] },
      ],
    },
  });

  const fee = selectApplicableDeliveryFee(fees, effectiveAt);
  if (!fee) {
    throw new Error(`No active delivery fee applies to shop ${input.shopId} / Delivery Company ${input.deliveryCompanyId} at ${effectiveAt.toISOString()}`);
  }

  return fee;
}

export async function recordShipmentDeliveredExpenses(
  event: ShipmentDeliveredEvent,
  database: Pick<typeof prisma, '$transaction'> = prisma,
  journalCreator: typeof createJournalEntryInTransaction = createJournalEntryInTransaction,
): Promise<void> {
  const input = buildShipmentDeliveredExpense(event);
  const expenseRepository = new ExpenseRepository();

  await database.$transaction(async (tx) => {
    const possibleReferences = getCandidateDeliveryExpenseReferences(input);
    const existingCharge = await tx.expense.findFirst({
      where: { expenseNo: { in: possibleReferences } },
    });

    let expense = existingCharge;

    if (!expense) {
      const fee = await findApplicableDeliveryFee(tx, input, input.expenseDate);
      if (fee.chargingBasis === 'PER_INVOICE') return;
      const expenseNo = buildDeliveryExpenseReference(fee.chargingBasis, input);

      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(
          hashtext('accounting.delivery-expense'),
          hashtext(${expenseNo})
        )
      `;

      expense = await tx.expense.findUnique({
        where: { expenseNo },
      });

      if (!expense) {
        const category = await tx.expenseCategory.upsert({
          where: { code: 'DELI' },
          update: { name: 'Deli', description: 'Shop-paid delivery-company expense' },
          create: {
            code: 'DELI',
            name: 'Deli',
            description: 'Shop-paid delivery-company expense',
          },
          select: { id: true },
        });

        expense = await expenseRepository.upsertExpense({
          expenseNo,
          scope: 'SHOP',
          shopId: input.shopId,
          deliveryCompanyId: input.deliveryCompanyId,
          expenseTypeId: category.id,
          expenseAccountCode: '5000',
          fundingAccountCode: '1000',
          amount: fee.amount,
          currency: fee.currency,
          description: `${input.description} (company ${input.deliveryCompanyId}; ${fee.chargingBasis})`,
          expenseDate: input.expenseDate,
          status: 'APPROVED',
        }, tx);
      }
    }

    const expenseNo = expense.expenseNo;
    const existingEntry = await expenseRepository.findJournalByExpenseReference(
      expenseNo,
      tx
    );
    if (existingEntry) return;

    await journalCreator({
      referenceType: 'EXPENSE',
      referenceId: expenseNo,
      eventId: event.event_id,
      narration: `Deli - ${expense.description ?? input.description}`,
      entryDate: expense.expenseDate,
      lines: [
        {
          accountCode: '5000',
          direction: 'DEBIT',
          amount: Number(expense.amount),
          memo: 'Deli',
        },
        {
          accountCode: '1000',
          direction: 'CREDIT',
          amount: Number(expense.amount),
          memo: 'Deli paid',
        },
      ],
    }, tx);
  });
}

export type DeliveryExpenseBatchInput = {
  groupId: string;
  shopId: string;
  deliveryCompanyId: string;
  orderIds: string[];
  effectiveAt: Date;
};

export async function recordCodCollectionBatchExpense(
  input: DeliveryExpenseBatchInput,
  eventId: string,
  database: Pick<typeof prisma, '$transaction'> = prisma,
  journalCreator: typeof createJournalEntryInTransaction = createJournalEntryInTransaction,
): Promise<void> {
  const normalizedOrderIds = input.orderIds.map((orderId) => orderId.trim());
  const orderIds = [...new Set(normalizedOrderIds)];
  if (
    !input.groupId.trim()
    || !input.shopId.trim()
    || !input.deliveryCompanyId.trim()
    || orderIds.length === 0
    || orderIds.length !== normalizedOrderIds.length
    || normalizedOrderIds.some((orderId) => !orderId)
  ) {
    throw new PermanentShipmentDeliveredEventError('Collect COD delivery expense requires a group, shop, provider, and orders');
  }

  const expenseRepository = new ExpenseRepository();
  await database.$transaction(async (tx) => {
    const feeLookupInput: DeliveryExpenseInput = {
      orderId: orderIds[0],
      deliveryId: input.groupId,
      deliveryNumber: input.groupId,
      deliveryCompanyId: input.deliveryCompanyId,
      shopId: input.shopId,
      expenseDate: input.effectiveAt,
      description: `Delivery expense for Collect COD batch ${input.groupId}`,
      deliveryExpenseGroupId: input.groupId,
    };
    const fee = await findApplicableDeliveryFee(tx, feeLookupInput, input.effectiveAt);
    if (fee.chargingBasis === 'PER_ORDER') return;

    const expenseNo = buildDeliveryExpenseReference(fee.chargingBasis, feeLookupInput);
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(
        hashtext('accounting.delivery-expense'),
        hashtext(${expenseNo})
      )
    `;

    let expense = await tx.expense.findUnique({ where: { expenseNo } });
    if (!expense) {
      const category = await tx.expenseCategory.upsert({
        where: { code: 'DELI' },
        update: { name: 'Deli', description: 'Shop-paid delivery-company expense' },
        create: {
          code: 'DELI',
          name: 'Deli',
          description: 'Shop-paid delivery-company expense',
        },
        select: { id: true },
      });

      expense = await expenseRepository.upsertExpense({
        expenseNo,
        scope: 'SHOP',
        shopId: input.shopId,
        deliveryCompanyId: input.deliveryCompanyId,
        deliveryExpenseGroupId: input.groupId,
        expenseTypeId: category.id,
        expenseAccountCode: '5000',
        fundingAccountCode: '1000',
        amount: fee.amount,
        currency: fee.currency,
        description: `${feeLookupInput.description} (company ${input.deliveryCompanyId}; ${fee.chargingBasis})`,
        expenseDate: input.effectiveAt,
        status: 'APPROVED',
      }, tx);
    }

    const existingOrderLinks = await tx.deliveryExpenseOrder.findMany({
      where: { expenseId: expense.id },
      select: { orderId: true },
    });
    if (existingOrderLinks.length > 0) {
      const existingOrderIds = existingOrderLinks.map((link) => link.orderId).sort();
      if (JSON.stringify(existingOrderIds) !== JSON.stringify(orderIds)) {
        throw new PermanentShipmentDeliveredEventError(
          `Collect COD batch ${input.groupId} was replayed with different order membership`,
        );
      }
    } else {
      await tx.deliveryExpenseOrder.createMany({
        data: orderIds.map((orderId) => ({ expenseId: expense.id, orderId })),
        skipDuplicates: true,
      });
    }

    if (await expenseRepository.findJournalByExpenseReference(expenseNo, tx)) return;
    await journalCreator({
      referenceType: 'EXPENSE',
      referenceId: expenseNo,
      eventId,
      narration: `Deli - ${expense.description ?? feeLookupInput.description}`,
      entryDate: expense.expenseDate,
      lines: [
        { accountCode: '5000', direction: 'DEBIT', amount: Number(expense.amount), memo: 'Deli' },
        { accountCode: '1000', direction: 'CREDIT', amount: Number(expense.amount), memo: 'Deli paid' },
      ],
    }, tx);
  });
}

let connection: ChannelModel | null = null;
let channel: Channel | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let shuttingDown = false;

const isDuplicate = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

const scheduleReconnect = (): void => {
  if (shuttingDown || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connectConsumer();
  }, 5000);
};

const consumeMessages = async (activeChannel: Channel): Promise<void> => {
  await activeChannel.prefetch(1);
  await activeChannel.consume(config.rabbitmqShipmentDeliveredQueue, (message) => {
    if (!message) return;

    void (async () => {
      try {
        const raw: unknown = JSON.parse(message.content.toString('utf8'));
        const event = normalizeShipmentDeliveredEvent(raw);
        await recordShipmentDeliveredExpenses(event);
        activeChannel.ack(message);
      } catch (error) {
        if (isDuplicate(error)) {
          console.info('Duplicate shipment.delivered expense reference ignored');
          activeChannel.ack(message);
          return;
        }

        if (error instanceof PermanentShipmentDeliveredEventError) {
          console.error('Skipping shipment.delivered event with invalid accounting metadata', error.message);
          activeChannel.nack(message, false, false);
          return;
        }

        console.error('Failed to account shipment.delivered event', error);
        activeChannel.nack(
          message,
          false,
          !(error instanceof z.ZodError || error instanceof SyntaxError)
        );
      }
    })();
  });
};

const connectConsumer = async (): Promise<void> => {
  if (shuttingDown || channel) return;

  let nextConnection: ChannelModel | null = null;
  let nextChannel: Channel | null = null;
  try {
    nextConnection = await connect(config.rabbitmqUrl);
    nextChannel = await nextConnection.createChannel();
    await nextChannel.assertExchange(config.rabbitmqExchange, 'topic', { durable: true });
    await nextChannel.assertQueue(config.rabbitmqShipmentDeliveredDlq, { durable: true });
    await nextChannel.assertQueue(config.rabbitmqShipmentDeliveredQueue, {
      durable: true,
      deadLetterExchange: '',
      deadLetterRoutingKey: config.rabbitmqShipmentDeliveredDlq,
    });
    await nextChannel.bindQueue(
      config.rabbitmqShipmentDeliveredQueue,
      config.rabbitmqExchange,
      config.rabbitmqShipmentDeliveredKey,
    );

    connection = nextConnection;
    channel = nextChannel;
    nextConnection.on('error', (error) =>
      console.error('Accounting shipment-delivered RabbitMQ connection error', error)
    );
    nextConnection.on('close', () => {
      connection = null;
      channel = null;
      scheduleReconnect();
    });

    await consumeMessages(nextChannel);
    console.log(`Accounting consumer listening for ${config.rabbitmqShipmentDeliveredKey}`);
  } catch (error) {
    console.error('Accounting shipment-delivered consumer failed to connect; retrying in 5 seconds', error);
    if (nextChannel) await nextChannel.close().catch(() => undefined);
    if (nextConnection) await nextConnection.close().catch(() => undefined);
    scheduleReconnect();
  }
};

export async function startShipmentDeliveredConsumer(): Promise<void> {
  shuttingDown = false;
  await connectConsumer();
}

export async function closeShipmentDeliveredConsumer(): Promise<void> {
  shuttingDown = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (channel) await channel.close();
  if (connection) await connection.close();
  channel = null;
  connection = null;
}
