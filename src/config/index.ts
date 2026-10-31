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
  rabbitmqInvoiceGeneratedKey: process.env.RABBITMQ_INVOICE_GENERATED_KEY || 'invoice.generated',
  rabbitmqInvoicePaidKey: process.env.RABBITMQ_INVOICE_PAID_KEY || 'invoice.paid',
  rabbitmqInvoiceProjectionQueue:
    process.env.RABBITMQ_INVOICE_PROJECTION_QUEUE || 'accounting.invoice_projection',
  rabbitmqInvoiceProjectionDlq:
    process.env.RABBITMQ_INVOICE_PROJECTION_DLQ || 'accounting.invoice_projection.dlq',
  rabbitmqInvoiceProjectionRetryExchange:
    process.env.RABBITMQ_INVOICE_PROJECTION_RETRY_EXCHANGE || 'accounting.invoice_projection.retry',
  rabbitmqInvoiceProjectionRetryQueue:
    process.env.RABBITMQ_INVOICE_PROJECTION_RETRY_QUEUE || 'accounting.invoice_projection.retry_queue',
  rabbitmqInvoiceProjectionRetryDelayMs: Number(
    process.env.RABBITMQ_INVOICE_PROJECTION_RETRY_DELAY_MS || 5000,
  ),
  rabbitmqInvoiceProjectionMaxRetries: Number(
    process.env.RABBITMQ_INVOICE_PROJECTION_MAX_RETRIES || 5,
  ),
  rabbitmqShipmentDeliveredKey: process.env.RABBITMQ_SHIPMENT_DELIVERED_KEY || 'shipment.delivered',
  rabbitmqShipmentDeliveredQueue:
    process.env.RABBITMQ_SHIPMENT_DELIVERED_QUEUE || 'accounting.shipment_delivered',
  rabbitmqShipmentDeliveredDlq:
    process.env.RABBITMQ_SHIPMENT_DELIVERED_DLQ || 'accounting.shipment_delivered.dlq',
  rabbitmqOrderReturnedKey: process.env.RABBITMQ_ORDER_RETURNED_KEY || 'order.returned',
  rabbitmqOrderReturnedQueue:
    process.env.RABBITMQ_ORDER_RETURNED_QUEUE || 'accounting.order_returned',
  rabbitmqOrderReturnedDlq:
    process.env.RABBITMQ_ORDER_RETURNED_DLQ || 'accounting.order_returned.dlq',
  rabbitmqInventoryValuationKey:
    process.env.RABBITMQ_INVENTORY_VALUATION_KEY || 'inventory.valuation.movement',
  rabbitmqInventoryValuationQueue:
    process.env.RABBITMQ_INVENTORY_VALUATION_QUEUE || 'accounting.inventory_valuation',
  rabbitmqInventoryValuationDlq:
    process.env.RABBITMQ_INVENTORY_VALUATION_DLQ || 'accounting.inventory_valuation.dlq',
  rabbitmqInventoryUpdatedKey: process.env.RABBITMQ_INVENTORY_UPDATED_KEY || 'inventory.updated',
  rabbitmqInventoryLowStockKey: process.env.RABBITMQ_INVENTORY_LOW_STOCK_KEY || 'inventory.low_stock',
  rabbitmqPurchaseGoodsReceivedKey:
    process.env.RABBITMQ_PURCHASE_GOODS_RECEIVED_KEY || 'purchase.goods_received',
  rabbitmqPurchaseGoodsReturnedKey:
    process.env.RABBITMQ_PURCHASE_GOODS_RETURNED_KEY || 'purchase.goods_returned',
  inventoryValuationCoverageFrom: process.env.INVENTORY_VALUATION_COVERAGE_FROM?.trim(),
  accountingEventsExchange: process.env.ACCOUNTING_EVENTS_EXCHANGE || 'accounting.events',
  accountingJournalEntryRoutingKey:
    process.env.ACCOUNTING_JOURNAL_ENTRY_ROUTING_KEY || 'accounting.journal-entry.upserted',
  shippingServiceBaseUrl: process.env.SHIPPING_SERVICE_BASE_URL?.trim(),
  nodeEnv: process.env.NODE_ENV || 'development',
};
