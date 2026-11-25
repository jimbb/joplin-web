import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { scanStatusService, ScanStatusService } from '../services/scan-status.js';

export function createScansRouter(service: ScanStatusService = scanStatusService): Router {
  const router = Router();
  router.use(requireAuth);

  /** GET /api/scans — current host scan pipeline status for allowed accounts. */
  router.get('/', async (req, res) => {
    res.status(200).json(await service.getStatus(req.userEmail));
  });

  return router;
}

export const scansRouter = createScansRouter();
