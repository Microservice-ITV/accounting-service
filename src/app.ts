import express from 'express';
import cors from 'cors';
import entriesRoutes from './modules/entries/entries.routes.js';
import accountsRoutes from './modules/accounts/accounts.routes.js';
import expensesRoutes from './modules/expenses/expenses.routes.js';
import expenseApprovalRoutes from './modules/expenses/expense-approval.routes.js';
import approvalPolicyRoutes from './modules/expenses/approval-policy.routes.js';
import profitLossRoutes from './modules/profit-loss/profit-loss.routes.js';
import deliveryCompanyFeeRoutes from './modules/delivery-company-fees/delivery-company-fees.routes.js';
import payrollPolicyRoutes from './modules/payroll-policies/payroll-policies.routes.js';
import payrollRunRoutes from './modules/payroll-runs/payroll-runs.routes.js';
import payrollRecordRoutes from './modules/payroll-records/payroll-records.routes.js';
import orderReturnStageRoutes from './modules/returns/order-return-stage.routes.js';

const app = express();
const MAX_JSON_BODY = '10mb';

app.use(cors());
app.use(express.json({ limit: MAX_JSON_BODY }));
app.use(express.urlencoded({ extended: true, limit: MAX_JSON_BODY }));

app.use((error: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (error && error.type === 'entity.too.large') {
    console.error('[EXPENSE_PAYLOAD_TOO_LARGE]', {
      url: req.originalUrl,
      contentType: req.headers['content-type'],
      contentLength: req.headers['content-length'] ?? 'unknown',
      maxBody: MAX_JSON_BODY,
    });
    return res.status(413).json({ error: 'Request payload too large.' });
  }
  return next(error);
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'accounting-service' });
});

app.get('/', (_req, res) => {
  res.json({ name: 'Accounting Service', status: 'running' });
});

app.use('/api/v1', entriesRoutes);
app.use('/api/v1', accountsRoutes);
app.use('/api/v1', expensesRoutes);
app.use('/api/v1', expenseApprovalRoutes);
app.use('/api/v1', approvalPolicyRoutes);
app.use('/api/v1', profitLossRoutes);
app.use('/api/v1', deliveryCompanyFeeRoutes);
app.use('/api/v1', payrollPolicyRoutes);
app.use('/api/v1', payrollRunRoutes);
app.use('/api/v1', payrollRecordRoutes);

// The React client calls the accounting service without the /api/v1 prefix.
app.use('/', payrollPolicyRoutes);
app.use('/', payrollRunRoutes);
app.use('/', payrollRecordRoutes);
app.use('/api/v1', orderReturnStageRoutes);
app.use('/api/v1/entries', orderReturnStageRoutes);

export default app;
