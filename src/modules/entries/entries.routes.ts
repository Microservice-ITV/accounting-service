import { Router } from 'express';
import { EntryController } from './controllers/entry.controller.js';
import type { IEntryService } from './interfaces/entry.service.interface.js';
import { EntryRepository } from './repositories/entry.repository.js';
import { EntryService } from './services/entry.service.js';

export function createEntriesRouter(
  service: IEntryService = new EntryService(new EntryRepository()),
) {
  const router = Router();
  const controller = new EntryController(service);

  router.get('/entries', controller.list);
  router.get('/entries/reference/:referenceType/:referenceId', controller.getByReference);
  router.post('/entries', controller.create);

  return router;
}

export default createEntriesRouter();
