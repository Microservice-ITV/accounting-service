import app from './app.js';
import { config } from './config/index.js';
import { closePaymentConsumer, startPaymentConsumer } from './infrastructure/rabbitmq/payment.consumer.js';
import {
  closeShipmentDeliveredConsumer,
  startShipmentDeliveredConsumer,
} from './infrastructure/rabbitmq/shipment-delivered.consumer.js';
import {
  closeOrderReturnedConsumer,
  startOrderReturnedConsumer,
} from './infrastructure/rabbitmq/return-stage.consumer.js';
import {
  closeDeliveryCompanyConfigurationRpcConsumer,
  startDeliveryCompanyConfigurationRpcConsumer,
} from './infrastructure/rabbitmq/delivery-company-configuration.rpc.consumer.js';
import {
  closeJournalEntryOutboxPublisher,
  startJournalEntryOutboxPublisher,
} from './infrastructure/rabbitmq/journal-entry-outbox.publisher.js';

const server = app.listen(config.port, () => {
  console.log(`${config.appName} running on port ${config.port}`);
});

startPaymentConsumer().catch((error) => {
  console.error('Failed to start accounting RabbitMQ consumer', error);
});
startShipmentDeliveredConsumer().catch((error) => {
  console.error('Failed to start shipment-delivered accounting consumer', error);
});
startOrderReturnedConsumer().catch((error) => {
  console.error('Failed to start order-returned accounting consumer', error);
});
startDeliveryCompanyConfigurationRpcConsumer().catch((error) => {
  console.error('Failed to start Delivery Company configuration RPC consumer', error);
});
startJournalEntryOutboxPublisher();

let isShuttingDown = false;

const shutdown = async () => {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  const shutdownTimeout = setTimeout(() => {
    server.closeAllConnections();
    process.exit(1);
  }, 5000);

  await Promise.allSettled([
    closePaymentConsumer(),
    closeShipmentDeliveredConsumer(),
    closeOrderReturnedConsumer(),
    closeDeliveryCompanyConfigurationRpcConsumer(),
    closeJournalEntryOutboxPublisher(),
    new Promise<void>((resolve) => server.close(() => resolve())),
  ]);

  clearTimeout(shutdownTimeout);
};

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
