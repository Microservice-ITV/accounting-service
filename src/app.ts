import express from 'express';
import cors from 'cors';
import entriesRoutes from './modules/entries/entries.routes.js';
import accountsRoutes from './modules/accounts/accounts.routes.js';
import expensesRoutes from './modules/expenses/expenses.routes.js';
import reportsRoutes from './modules/reports/reports.routes.js';

const app = express();

app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'accounting-service' });
});

app.get('/', (_req, res) => {
  res.json({ name: 'Accounting Service', status: 'running' });
});

app.use('/api/v1', entriesRoutes);
app.use('/api/v1', accountsRoutes);
app.use('/api/v1', expensesRoutes);
app.use('/api/v1', reportsRoutes);

export default app;
