import { Router } from 'express';
import type { Request, Response } from 'express';
import pool from '../db.js';
import {
  createPage, getPage, listPages, getPageTree, updatePage, deletePage,
  getPageStageStatuses, upsertPageStageStatus, getArtifactsByPageId,
  updateArtifactVersioned, softDeleteArtifact, createArtifactDirect,
} from '../services/pipeline-queries.js';
import { broadcastSSE } from '../services/sse-manager.js';

const router = Router();

// List pages
router.get('/', async (req: Request, res: Response) => {
  try {
    const tenantId = (req as any).user?.tenantId;
    const pages = await listPages(pool, tenantId);
    if (req.query.module) {
      res.json(pages.filter(p => p.module === req.query.module));
    } else {
      res.json(pages);
    }
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Create page
router.post('/', async (req: Request, res: Response) => {
  try {
    const tenantId = (req as any).user?.tenantId;
    const { module, page_slug, display_name, target_url, parent_page_id, metadata } = req.body;
    if (!module || !page_slug || !display_name) {
      res.status(400).json({ error: 'module, page_slug, and display_name are required' });
      return;
    }
    const page = await createPage(pool, { tenant_id: tenantId, module, page_slug, display_name, target_url, parent_page_id, metadata });
    res.status(201).json(page);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Page tree
router.get('/tree', async (req: Request, res: Response) => {
  try {
    const tenantId = (req as any).user?.tenantId;
    const tree = await getPageTree(pool, tenantId);
    res.json(tree);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Page detail
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const page = await getPage(pool, req.params.id as string);
    if (!page) { res.status(404).json({ error: 'Page not found' }); return; }
    const [stages, artifacts] = await Promise.all([
      getPageStageStatuses(pool, page.id),
      getArtifactsByPageId(pool, page.id),
    ]);
    res.json({ ...page, stages, artifacts });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Update page
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const updated = await updatePage(pool, req.params.id as string, req.body);
    if (!updated) { res.status(404).json({ error: 'Page not found' }); return; }
    res.json(updated);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Delete page
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const deleted = await deletePage(pool, req.params.id as string);
    if (!deleted) { res.status(404).json({ error: 'Page not found' }); return; }
    res.json({ deleted: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Stage statuses
router.get('/:id/stages', async (req: Request, res: Response) => {
  try {
    const stages = await getPageStageStatuses(pool, req.params.id as string);
    res.json(stages);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Artifacts
router.post('/artifacts', async (req: Request, res: Response) => {
  try {
    const { runId, name, type, content, pageId } = req.body;
    if (!runId || !name || !type || !content) {
      res.status(400).json({ error: 'runId, name, type, and content are required' });
      return;
    }
    const artifact = await createArtifactDirect(pool, runId, name, type, content, pageId);
    res.status(201).json(artifact);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Update artifact
router.put('/artifacts/:id', async (req: Request, res: Response) => {
  try {
    const { content, editedBy } = req.body;
    if (!content || !editedBy) { res.status(400).json({ error: 'content and editedBy required' }); return; }
    const newVersion = await updateArtifactVersioned(pool, req.params.id as string, content, editedBy);
    res.json(newVersion);
  } catch (err: any) { res.status(404).json({ error: err.message }); }
});

// Delete artifact
router.delete('/artifacts/:id', async (req: Request, res: Response) => {
  try {
    const deleted = await softDeleteArtifact(pool, req.params.id as string, req.body.deletedBy || 'unknown');
    if (!deleted) { res.status(404).json({ error: 'Artifact not found' }); return; }
    res.json({ deleted: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

export default router;
