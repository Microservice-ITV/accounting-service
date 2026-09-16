import dotenv from 'dotenv';

dotenv.config();

export const config = {
  port: Number(process.env.PORT || 4005),
  appName: process.env.APP_NAME || 'Accounting Service',
  databaseUrl: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5433/accounting_service?schema=public',
  rabbitmqUrl: process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5673',
  rabbitmqExchange: process.env.RABBITMQ_EXCHANGE || 'order_events',
  rabbitmqPaymentCompletedKey: process.env.RABBITMQ_PAYMENT_COMPLETED_KEY || 'payment.completed',
  rabbitmqPaymentQueue: process.env.RABBITMQ_PAYMENT_QUEUE || 'accounting.payment_completed',
  rabbitmqPaymentDlq: process.env.RABBITMQ_PAYMENT_DLQ || 'accounting.payment_completed.dlq',
  nodeEnv: process.env.NODE_ENV || 'development',
};
