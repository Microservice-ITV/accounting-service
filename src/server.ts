import app from './app.js';
import { config } from './config/index.js';
import { closePaymentConsumer, startPaymentConsumer } from './infrastructure/rabbitmq/payment.consumer.js';

const server = app.listen(config.port, () => {
  console.log(`${config.appName} running on port ${config.port}`);
});

startPaymentConsumer().catch((error) => {
  console.error('Failed to start accounting RabbitMQ consumer', error);
});

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
    new Promise<void>((resolve) => server.close(() => resolve())),
  ]);

  clearTimeout(shutdownTimeout);
};

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
