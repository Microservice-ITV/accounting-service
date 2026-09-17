import { Router } from 'express';
import { z } from 'zod';
import { createExpense, createJournalEntry, getEntryByReference, listEntries } from './entry.service.js';

const router = Router();

const expenseSchema = z.object({
  referenceId: z.string().min(1),
  amount: z.number().finite().positive(),
  expenseAccountCode: z.string().min(1).optional(),
  fundingAccountCode: z.string().min(1).optional(),
  eventId: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
});

router.get('/entries', async (_req, res) => {
  try {
    const entries = await listEntries();
    res.json(entries);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to fetch entries';
    res.status(500).json({ error: message });
  }
});

router.get('/entries/reference/:referenceType/:referenceId', async (req, res) => {
  try {
    const entry = await getEntryByReference(req.params.referenceType, req.params.referenceId);
    if (!entry) {
      return res.status(404).json({ error: 'Entry not found' });
    }

    return res.json(entry);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to fetch entry';
    return res.status(500).json({ error: message });
  }
});

router.post('/entries', async (req, res) => {
  try {
    const { referenceType, referenceId, eventId, narration, lines } = req.body;

    if (!referenceType || !referenceId || !Array.isArray(lines)) {
      return res.status(400).json({ error: 'referenceType, referenceId, and lines are required' });
    }

    const entry = await createJournalEntry({
      referenceType,
      referenceId,
      eventId,
      narration,
      lines,
    });

    return res.status(201).json(entry);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create journal entry';
    return res.status(400).json({ error: message });
  }
});

router.post('/expenses', async (req, res) => {
  try {
    const expense = expenseSchema.parse(req.body);
    const entry = await createExpense(expense);
    return res.status(201).json(entry);
  } catch (error) {
    const message = error instanceof z.ZodError
      ? error.issues[0]?.message || 'Invalid expense payload'
      : error instanceof Error
        ? error.message
        : 'Failed to create expense';
    return res.status(400).json({ error: message });
  }
});

export default router;
