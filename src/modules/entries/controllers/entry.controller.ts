import type { RequestHandler, Response } from 'express';
import { z } from 'zod';
import type { IEntryService } from '../interfaces/entry.service.interface.js';
import { EntryApplicationError } from '../errors/entry.error.js';
import { createJournalEntrySchema } from '../dto/entry.dto.js';

function getParam(value: string | string[]) {
  return Array.isArray(value) ? value[0] : value;
}

export class EntryController {
  constructor(private readonly entryService: IEntryService) {}

  private sendError(res: Response, error: unknown, fallback: string, status: number) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.issues[0]?.message ?? fallback });
    }
    if (error instanceof EntryApplicationError) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    const message = error instanceof Error ? error.message : fallback;
    return res.status(status).json({ error: message });
  }

  list: RequestHandler = async (_req, res) => {
    try {
      return res.json(await this.entryService.list());
    } catch (error) {
      return this.sendError(res, error, 'Failed to fetch entries', 500);
    }
  };

  getByReference: RequestHandler = async (req, res) => {
    try {
      const entry = await this.entryService.getByReference(
        getParam(req.params.referenceType),
        getParam(req.params.referenceId),
      );
      if (!entry) return res.status(404).json({ error: 'Entry not found' });
      return res.json(entry);
    } catch (error) {
      return this.sendError(res, error, 'Failed to fetch entry', 500);
    }
  };

  create: RequestHandler = async (req, res) => {
    try {
      const body = req.body as Record<string, unknown> | null;
      if (!body?.referenceType || !body.referenceId || !Array.isArray(body.lines)) {
        return res.status(400).json({
          error: 'referenceType, referenceId, and lines are required',
        });
      }
      const input = createJournalEntrySchema.parse(req.body);
      const entry = await this.entryService.create(input);
      return res.status(201).json(entry);
    } catch (error) {
      return this.sendError(res, error, 'Failed to create journal entry', 400);
    }
  };
}
