import app from './app.js';
import { config } from './config/index.js';
import { closePaymentConsumer, startPaymentConsumer } from './infrastructure/rabbitmq/payment.consumer.js';

const server = app.listen(config.port, () => {
  console.log(`${config.appName} running on port ${config.port}`);
});

startPaymentConsumer().catch((error) => {
  console.error('Failed to start accounting RabbitMQ consumer', error);
});

const shutdown = async () => {
  await closePaymentConsumer();
  await new Promise<void>((resolve) => server.close(() => resolve()));
};

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
