import { Router } from 'express';
import { z } from 'zod';
import { createJournalEntry, getEntryByReference, listEntries } from './entry.service.js';

const router = Router();

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

export default router;
