/**
 * JBS IntelliQE backend — Express entry point.
 *
 * Wires in HIPAA-grade middleware:
 *   - helmet            → security headers (CSP, HSTS, X-Frame-Options...)
 *   - rate-limit        → 100 req/min general, 5 req/min on /auth/*
 *   - cors              → locked to ALLOWED_ORIGINS in production
 *   - request-context   → stamps X-Request-Id on every request
 *
 * Auth:
 *   - JWT for users (HS256 with JWT_SECRET)
 *   - x-worker-secret for worker tasks (WORKER_SECRET)
 *
 * Routes are split into:
 *   - Internal admin/UI:  /api/*           (user JWT)
 *   - Public capability:  /api/v1/public/* (user JWT + audit middleware)
 *   - Worker:             /api/pipeline-worker/* (worker secret)
 */
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcrypt';
import generateRoutes from './routes/generate.routes.js';
import executeRoutes from './routes/execute.routes.js';
import pipelineFlowRoutes from './routes/pipeline-flow.routes.js';
import agentsRoutes from './routes/agents.routes.js';
import chatRoutes from './routes/chat.routes.js';
import jiraRoutes from './routes/jira.routes.js';
import azureDevopsRoutes from './routes/azure-devops.routes.js';
import documentRoutes from './routes/document.routes.js';
import gitRoutes from './routes/git.routes.js';
import confluenceRoutes from './routes/confluence.routes.js';
import sharepointRoutes from './routes/sharepoint.routes.js';
import testCasesRoutes from './routes/test-cases.routes.js';
import configurationsRoutes from './routes/configurations.routes.js';
import reportsRoutes from './routes/reports.routes.js';
import pipelineRoutes from './routes/pipeline.routes.js';
import pipelineEventsRoutes from './routes/pipeline-events.routes.js';
import pipelineWorkerRoutes from './routes/pipeline-worker.routes.js';
import pipelineAdminRoutes from './routes/pipeline-admin.routes.js';
import pipelinePagesRoutes from './routes/pipeline-pages.routes.js';
import artifactsRoutes from './routes/artifacts.routes.js';
import userManagementRoutes from './routes/user-management.routes.js';
import allureRoutes from './routes/allure.routes.js';
import tenantSettingsRoutes from './routes/tenant-settings.routes.js';
import llmConfigRoutes from './routes/llm-config.routes.js';
import publicApiRoutes from './routes/public/public-api.routes.js';
import clientLogsRoutes from './routes/client-logs.routes.js';
import bugsRoutes from './routes/bugs.routes.js';
import { initDb } from './db.js';
import pool from './db.js';
import { decryptField } from './utils/crypto.js';
import { signToken } from './utils/jwt.js';
import { authMiddleware } from './middleware/auth.middleware.js';
import { requestContext } from './middleware/request-context.middleware.js';
import { auditMutations } from './middleware/audit.middleware.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.middleware.js';
import { logger } from './utils/logger.js';
import { setEventCallback } from './orchestrator/orchestrator.js';
import { broadcastSSE } from './services/sse-manager.js';

const app = express();
const PORT = Number(process.env.PORT) || 3001;
const NODE_ENV = process.env.NODE_ENV || 'development';

/* ─────────────────────────────────────────────────────────────
   Trust proxy (so req.ip works behind Azure App Service / ELB)
   ───────────────────────────────────────────────────────────── */
app.set('trust proxy', 1);

/* ─────────────────────────────────────────────────────────────
   Security headers
   ───────────────────────────────────────────────────────────── */
app.use(
  helmet({
    contentSecurityPolicy: NODE_ENV === 'production' ? undefined : false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }),
);

/* ─────────────────────────────────────────────────────────────
   CORS — wildcard in dev, env-locked in prod
   ───────────────────────────────────────────────────────────── */
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '*')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
        cb(null, true);
      } else {
        cb(new Error(`Origin ${origin} not allowed by CORS`));
      }
    },
    credentials: true,
  }),
);

app.use(express.json({ limit: '5mb' }));
app.use(requestContext);

/* ─────────────────────────────────────────────────────────────
   Rate limits
   ───────────────────────────────────────────────────────────── */
const generalLimiter = rateLimit({
  windowMs: 60_000,
  limit: Number(process.env.RATE_LIMIT_GENERAL || 100),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});
const authLimiter = rateLimit({
  windowMs: 60_000,
  limit: Number(process.env.RATE_LIMIT_AUTH || 5),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});
// Client diagnostics get their own (looser) budget so a noisy browser tab
// reporting errors can't exhaust the app's general request allowance.
const clientLogLimiter = rateLimit({
  windowMs: 60_000,
  limit: Number(process.env.RATE_LIMIT_CLIENT_LOGS || 300),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

/* ─────────────────────────────────────────────────────────────
   Client log ingest (no auth, own rate limit) — mounted before the
   general limiter so browser error bursts don't starve real traffic.
   ───────────────────────────────────────────────────────────── */
app.use('/api/client-logs', clientLogLimiter, clientLogsRoutes);

app.use('/api/', generalLimiter);

/* ─────────────────────────────────────────────────────────────
   Public routes (no auth)
   ───────────────────────────────────────────────────────────── */
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '1.0.0' });
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const { username, password: rawPassword } = req.body;
    const password = decryptField(rawPassword || '');

    const { rows } = await pool.query(
      `SELECT u.id, u.username, u.password_hash, u.full_name, u.role, u.is_active,
              t.id AS tenant_id, t.name AS tenant_name, t.slug AS tenant_slug, t.is_platform
       FROM users u
       JOIN tenants t ON t.id = u.tenant_id
       WHERE u.username = $1`,
      [username],
    );

    if (rows.length === 0) {
      res.status(401).json({ success: false, error: 'Invalid credentials' });
      return;
    }
    if (!rows[0].is_active) {
      res.status(401).json({ success: false, error: 'Account is deactivated. Contact your administrator.' });
      return;
    }

    const stored = rows[0].password_hash as string;
    const isBcrypt = typeof stored === 'string' && /^\$2[aby]\$/.test(stored);
    const match = isBcrypt ? await bcrypt.compare(password, stored) : stored === password;
    if (!match) {
      res.status(401).json({ success: false, error: 'Invalid credentials' });
      return;
    }

    const row = rows[0];
    const token = signToken({
      sub: row.username,
      uid: row.id,
      role: row.role,
      tid: row.tenant_id,
      tn: row.tenant_name,
      pf: row.is_platform,
    });

    res.json({
      success: true,
      user: {
        username: row.username,
        role: row.role,
        displayName: row.full_name,
        tenantId: row.tenant_id,
        tenantName: row.tenant_name,
        isPlatform: row.is_platform,
      },
      token,
    });
  } catch (err: any) {
    logger.error('Login error', { err: err.message });
    res.status(500).json({ success: false, error: 'Login failed' });
  }
});

app.post('/api/auth/signup', authLimiter, async (req, res) => {
  try {
    const { username, password: rawPassword, fullName, email, role, tenantName } = req.body;
    const password = decryptField(rawPassword || '');

    if (!username || !password || !role) {
      res.status(400).json({ success: false, error: 'Missing required fields' });
      return;
    }

    const existing = await pool.query(`SELECT id FROM users WHERE username = $1`, [username]);
    if (existing.rows.length > 0) {
      res.status(409).json({ success: false, error: 'Username already exists' });
      return;
    }

    let tenantId: string;
    if (tenantName) {
      const slug = tenantName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
      const tenantResult = await pool.query(
        `MERGE INTO tenants WITH (HOLDLOCK) AS t
         USING (SELECT $2 AS slug) AS s ON t.slug = s.slug
         WHEN MATCHED THEN UPDATE SET name = $1
         WHEN NOT MATCHED THEN INSERT (name, slug, is_platform) VALUES ($1, $2, 0)
         OUTPUT INSERTED.id;`,
        [tenantName, slug],
      );
      tenantId = tenantResult.rows[0].id;
    } else {
      const jbs = await pool.query(`SELECT id FROM tenants WHERE slug = 'jbs'`);
      tenantId = jbs.rows[0].id;
    }

    const passwordHash = await bcrypt.hash(password, 10);
    await pool.query(
      `INSERT INTO users (tenant_id, username, password_hash, email, full_name, role)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [tenantId, username, passwordHash, email || null, fullName || username, role],
    );

    res.json({ success: true, message: 'Account created successfully' });
  } catch (err: any) {
    logger.error('Signup error', { err: err.message });
    res.status(500).json({ success: false, error: 'Signup failed' });
  }
});

/* ─────────────────────────────────────────────────────────────
   Internal admin / UI routes (user JWT required)
   ───────────────────────────────────────────────────────────── */
app.use('/api/generate', authMiddleware, generateRoutes);
app.use('/api/execute', authMiddleware, executeRoutes);
app.use('/api/pipeline-flow', authMiddleware, pipelineFlowRoutes);
app.use('/api/agents', authMiddleware, agentsRoutes);
app.use('/api/chat', authMiddleware, chatRoutes);
app.use('/api/jira', authMiddleware, jiraRoutes);
app.use('/api/azure-devops', authMiddleware, azureDevopsRoutes);
app.use('/api/document', authMiddleware, documentRoutes);
app.use('/api/git', authMiddleware, gitRoutes);
app.use('/api/confluence', authMiddleware, confluenceRoutes);
app.use('/api/sharepoint', authMiddleware, sharepointRoutes);
app.use('/api/test-cases', authMiddleware, testCasesRoutes);
app.use('/api/bugs', authMiddleware, bugsRoutes);
app.use('/api/configurations', authMiddleware, configurationsRoutes);
app.use('/api/reports', authMiddleware, reportsRoutes);
app.use('/api/tenant-settings', authMiddleware, tenantSettingsRoutes);
app.use('/api/llm-config', authMiddleware, llmConfigRoutes);

app.use('/api/pipeline', authMiddleware, pipelineRoutes);
app.use('/api/pipeline-events', authMiddleware, pipelineEventsRoutes);
app.use('/api/pipeline-pages', authMiddleware, pipelinePagesRoutes);
app.use('/api/pipeline-admin', authMiddleware, pipelineAdminRoutes);
app.use('/api/pipeline-worker', pipelineWorkerRoutes);  // worker secret auth
app.use('/api/artifacts', authMiddleware, artifactsRoutes);
app.use('/api/users', authMiddleware, userManagementRoutes);
app.use('/api/allure', allureRoutes);

/* ─────────────────────────────────────────────────────────────
   Public business-capability API (HIPAA boundary)
   - User JWT today; swap to tenant-scoped API token via a different
     middleware here when partner integrations land.
   - Audit middleware automatically logs every call.
   ───────────────────────────────────────────────────────────── */
app.use('/api/v1/public', authMiddleware, auditMutations, publicApiRoutes);

/* ─────────────────────────────────────────────────────────────
   404 + global error handler — standard JSON shape everywhere.
   Mounted last so they catch anything bubbling up from the routes.
   ───────────────────────────────────────────────────────────── */
app.use('/api', notFoundHandler);
app.use(errorHandler);

setEventCallback((runId, event) => broadcastSSE(runId, event));

initDb()
  .then(() => {
    app.listen(PORT, () => {
      logger.info(`JBS IntelliQE API listening`, { port: PORT, env: NODE_ENV });
    });
  })
  .catch((err) => {
    logger.error('DB init failed, starting without DB', { err: err.message });
    app.listen(PORT, () => {
      logger.warn('Started without DB', { port: PORT });
    });
  });
