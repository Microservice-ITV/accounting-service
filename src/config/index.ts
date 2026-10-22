import dotenv from 'dotenv';

dotenv.config();

export const config = {
  port: Number(process.env.PORT || 4005),
  appName: process.env.APP_NAME || 'Accounting Service',
  databaseUrl: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5433/accounting_service?schema=public',
  rabbitmqUrl: process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5673',
  rabbitmqExchange: process.env.RABBITMQ_EXCHANGE || 'order_events',
  rabbitmqPaymentCompletedKey: process.env.RABBITMQ_PAYMENT_COMPLETED_KEY || 'payment.completed',
  rabbitmqPaymentCollectedKey: process.env.RABBITMQ_PAYMENT_COLLECTED_KEY || 'payment.collected',
  rabbitmqOrderPaidKey: process.env.RABBITMQ_ORDER_PAID_KEY || 'order.paid',
  rabbitmqPaymentQueue: process.env.RABBITMQ_PAYMENT_QUEUE || 'accounting.payment_completed',
  rabbitmqPaymentDlq: process.env.RABBITMQ_PAYMENT_DLQ || 'accounting.payment_completed.dlq',
  rabbitmqShipmentDeliveredKey: process.env.RABBITMQ_SHIPMENT_DELIVERED_KEY || 'shipment.delivered',
  rabbitmqShipmentDeliveredQueue:
    process.env.RABBITMQ_SHIPMENT_DELIVERED_QUEUE || 'accounting.shipment_delivered',
  rabbitmqShipmentDeliveredDlq:
    process.env.RABBITMQ_SHIPMENT_DELIVERED_DLQ || 'accounting.shipment_delivered.dlq',
  accountingEventsExchange: process.env.ACCOUNTING_EVENTS_EXCHANGE || 'accounting.events',
  accountingJournalEntryRoutingKey:
    process.env.ACCOUNTING_JOURNAL_ENTRY_ROUTING_KEY || 'accounting.journal-entry.upserted',
  shippingServiceBaseUrl: process.env.SHIPPING_SERVICE_BASE_URL?.trim(),
  nodeEnv: process.env.NODE_ENV || 'development',
};
