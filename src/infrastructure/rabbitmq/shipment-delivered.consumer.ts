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
    provider_id: z.string().min(1).nullish(),
    shop_id: z.string().min(1).nullish(),
    delivery: z.object({
      deliveryId: z.string().min(1),
      deliveryNumber: z.string().min(1),
      providerId: z.string().min(1).nullish(),
      provider_id: z.string().min(1).nullish(),
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
  providerId: string;
  legacyProviderCode: string | null;
  shopId: string;
  expenseDate: Date;
  description: string;
};

export function buildShipmentDeliveredExpense(event: ShipmentDeliveredEvent): DeliveryExpenseInput {
  const delivery = event.data.delivery;
  const providerIds = [
    event.data.provider_id,
    delivery.providerId,
    delivery.provider_id,
  ].filter((providerId): providerId is string => Boolean(providerId?.trim()))
    .map((providerId) => providerId.trim());
  const distinctProviderIds = [...new Set(providerIds)];
  if (distinctProviderIds.length === 0) {
    throw new PermanentShipmentDeliveredEventError(
      `shipment.delivered for delivery ${delivery.deliveryId} is missing the Delivery Service provider ID`
    );
  }
  if (distinctProviderIds.length > 1) {
    throw new PermanentShipmentDeliveredEventError(
      `shipment.delivered for delivery ${delivery.deliveryId} contains conflicting provider IDs`
    );
  }
  const providerId = distinctProviderIds[0];

  const deliveredAt = new Date(delivery.timeline.deliveredAt);
  if (Number.isNaN(deliveredAt.getTime())) {
    throw new PermanentShipmentDeliveredEventError(
      `shipment.delivered for delivery ${delivery.deliveryId} has an invalid data.delivery.timeline.deliveredAt`
    );
  }

  const items = delivery.items ?? [];
  const shopIds = items.map((item) => item.shopId?.trim() ?? '');
  const declaredShopId = event.data.shop_id?.trim() || delivery.shopId?.trim() || '';
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
    providerId,
    legacyProviderCode: delivery.courier.code?.trim() || null,
    shopId,
    expenseDate: deliveredAt,
    description,
  };
}

type DeliveryFeeCandidate = Pick<
  Prisma.DeliveryProviderFeeGetPayload<{}>,
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
  chargingBasis: 'PER_ORDER' | 'PER_DAY',
  input: Pick<DeliveryExpenseInput, 'providerId' | 'shopId' | 'orderId' | 'expenseDate'>,
): string {
  const chargeKey = chargingBasis === 'PER_ORDER'
    ? [input.providerId, input.shopId, input.orderId]
    : [input.providerId, input.shopId, input.expenseDate.toISOString().slice(0, 10)];
  const digest = createHash('sha256').update(JSON.stringify(chargeKey)).digest('hex');
  return `DELI-${chargingBasis === 'PER_ORDER' ? 'ORDER' : 'DAY'}-${digest}`;
}

function getCandidateDeliveryExpenseReferences(input: DeliveryExpenseInput): string[] {
  const references = [
    buildDeliveryExpenseReference('PER_ORDER', input),
    buildDeliveryExpenseReference('PER_DAY', input),
    `DELI-${input.deliveryId}`,
  ];
  if (input.legacyProviderCode) {
    const legacyInput = {
      providerId: input.legacyProviderCode,
      shopId: input.shopId,
      orderId: input.orderId,
      expenseDate: input.expenseDate,
    };
    references.push(
      buildDeliveryExpenseReference('PER_ORDER', legacyInput),
      buildDeliveryExpenseReference('PER_DAY', legacyInput),
    );
  }
  return [...new Set(references)];
}

async function findApplicableDeliveryFee(
  transaction: Prisma.TransactionClient,
  providerId: string,
  effectiveAt: Date,
) {
  const fees = await transaction.deliveryProviderFee.findMany({
    where: {
      providerId,
      active: true,
      AND: [
        { OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: effectiveAt } }] },
        { OR: [{ effectiveTo: null }, { effectiveTo: { gt: effectiveAt } }] },
      ],
    },
  });

  const fee = selectApplicableDeliveryFee(fees, effectiveAt);
  if (!fee) {
    throw new Error(`No active delivery fee applies to provider ID ${providerId} at ${effectiveAt.toISOString()}`);
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
      const fee = await findApplicableDeliveryFee(tx, input.providerId, input.expenseDate);
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
          update: { name: 'Deli', description: 'Shop-paid delivery-provider expense' },
          create: {
            code: 'DELI',
            name: 'Deli',
            description: 'Shop-paid delivery-provider expense',
          },
          select: { id: true },
        });

        expense = await expenseRepository.upsertExpense({
          expenseNo,
          scope: 'SHOP',
          shopId: input.shopId,
          deliveryProviderId: input.providerId,
          expenseTypeId: category.id,
          expenseAccountCode: '5000',
          fundingAccountCode: '1000',
          amount: fee.amount,
          currency: fee.currency,
          description: `${input.description} (provider ${input.providerId}; ${fee.chargingBasis})`,
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
