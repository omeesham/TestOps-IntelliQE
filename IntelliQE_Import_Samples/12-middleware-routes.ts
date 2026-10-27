// Paste this into the Middleware method (AI-read). Every registered route
// becomes an endpoint. (Routes are relative — set the base URL in an Environment,
// e.g. https://jsonplaceholder.typicode.com, to run them live.)

import { Router, Request, Response } from 'express';

const router = Router();

// GET /posts — list posts
router.get('/posts', (_req: Request, res: Response) => {
  res.json([{ id: 1, title: 'hello' }]);
});

// GET /posts/:id — one post
router.get('/posts/:id', (req: Request, res: Response) => {
  res.json({ id: Number(req.params.id), title: 'hello' });
});

// POST /posts — create a post
router.post('/posts', (req: Request, res: Response) => {
  res.status(201).json({ id: 101, ...req.body });
});

// PUT /posts/:id — replace a post
router.put('/posts/:id', (req: Request, res: Response) => {
  res.json({ id: Number(req.params.id), ...req.body });
});

// DELETE /posts/:id — remove a post
router.delete('/posts/:id', (_req: Request, res: Response) => {
  res.status(204).end();
});

// GET /comments?postId= — comments for a post
router.get('/comments', (req: Request, res: Response) => {
  res.json([{ id: 1, postId: Number(req.query.postId), body: 'nice' }]);
});

export default router;
