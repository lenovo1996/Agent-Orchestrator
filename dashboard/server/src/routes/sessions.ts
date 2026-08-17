import { Router } from 'express';
import type { DashboardConfig } from '../config.js';
import { SessionService } from '../session/service.js';

function workspaceName(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

export function sessionsRouter(config: DashboardConfig, service: SessionService): Router {
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.get('/flows/:flowId/sessions/:step', (req, res) => {
    if (!config.sessionViewerEnabled) {
      res.status(503).json({ enabled: false, attempts: [] });
      return;
    }
    try {
      const attempts = service.list(req.params.flowId, req.params.step, workspaceName(req.query.workspaceName));
      res.json({ enabled: true, attempts });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  router.get('/flows/:flowId/sessions/:step/:runId', async (req, res) => {
    if (!config.sessionViewerEnabled) {
      res.status(503).json({ enabled: false });
      return;
    }
    try {
      const snapshot = await service.snapshot(
        req.params.flowId, req.params.step, req.params.runId, workspaceName(req.query.workspaceName),
      );
      if (!snapshot) {
        res.status(404).json({ error: 'Session attempt not found' });
        return;
      }
      res.json(snapshot);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  router.get('/flows/:flowId/sessions/:step/:runId/items/:itemId', async (req, res) => {
    if (!config.sessionViewerEnabled) {
      res.status(503).json({ enabled: false });
      return;
    }
    try {
      const detail = await service.detail(
        req.params.flowId,
        req.params.step,
        req.params.runId,
        req.params.itemId,
        workspaceName(req.query.workspaceName),
      );
      if (!detail) {
        res.status(404).json({ error: 'Session item detail not found' });
        return;
      }
      res.json(detail);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  return router;
}
