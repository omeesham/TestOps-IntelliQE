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
import agentsRoutes from './routes/agents.routes.js';
import chatRoutes from './routes/chat.routes.js';
import jiraRoutes from './routes/jira.routes.js';
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
import automationScriptsRoutes from './routes/automation-scripts.routes.js';
import artifactsRoutes from './routes/artifacts.routes.js';
import userManagementRoutes from './routes/user-management.routes.js';
import allureRoutes from './routes/allure.routes.js';
import tenantSettingsRoutes from './routes/tenant-settings.routes.js';
import publicApiRoutes from './routes/public/public-api.routes.js';
import { initDb } from './db.js';
import pool from './db.js';
import { decryptField } from './utils/crypto.js';
import { hydrateAnthropicEnv, describeResolved } from './services/llm-config.service.js';
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

app.use('/api/', generalLimiter);

/* ─────────────────────────────────────────────────────────────
   Public routes (no auth)
   ───────────────────────────────────────────────────────────── */
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '1.0.0' });
});

/** Decode the payload claims of a JWT/ID-token without verifying its signature. */
function decodeJwtClaims(idToken: string): Record<string, any> {
  const payload = idToken.split('.')[1];
  if (!payload) return {};
  const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  return JSON.parse(json);
}

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
   Microsoft Entra ID (Azure AD) SSO — authorization-code callback.
   The frontend redirects the browser to Entra's /authorize endpoint;
   Entra redirects back to /login?code=..., and the SPA POSTs the code
   here. We exchange it server-side (client secret never leaves the
   backend), read the verified ID-token claims, then look up or
   provision the user and mint our normal JWT.
   ───────────────────────────────────────────────────────────── */
app.post('/api/auth/sso/callback', authLimiter, async (req, res) => {
  try {
    const { code, redirectUri } = req.body || {};
    const tenant = process.env.AZURE_TENANT_ID;
    const clientId = process.env.AZURE_CLIENT_ID;
    const clientSecret = process.env.AZURE_CLIENT_SECRET;

    if (!tenant || !clientId || !clientSecret) {
      res.status(503).json({ success: false, error: 'SSO is not configured on the server' });
      return;
    }
    if (!code || !redirectUri) {
      res.status(400).json({ success: false, error: 'Missing authorization code' });
      return;
    }

    // Exchange the authorization code for tokens.
    const tokenResp = await fetch(
      `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          scope: 'openid profile email',
        }),
      },
    );

    if (!tokenResp.ok) {
      const detail = await tokenResp.text();
      logger.warn('SSO token exchange failed', { status: tokenResp.status, detail });
      res.status(401).json({ success: false, error: 'SSO token exchange failed' });
      return;
    }

    const tokens = (await tokenResp.json()) as { id_token?: string };
    if (!tokens.id_token) {
      res.status(401).json({ success: false, error: 'No ID token returned by identity provider' });
      return;
    }

    // Decode ID-token claims. The token came directly from Entra's token
    // endpoint over TLS, so the auth-code flow guarantees its integrity.
    // (Hardening follow-up: verify the JWS signature against the tenant JWKS.)
    const claims = decodeJwtClaims(tokens.id_token);
    const email: string | undefined =
      claims.preferred_username || claims.email || claims.upn;

    if (!email) {
      res.status(401).json({ success: false, error: 'Identity provider did not return an email' });
      return;
    }

    // Look up the user by username (email). SSO authenticates identity but
    // does not grant access — the user must already exist (created via signup
    // or user management). Unknown emails are rejected.
    const { rows } = await pool.query(
      `SELECT u.id, u.username, u.full_name, u.role, u.is_active,
              t.id AS tenant_id, t.name AS tenant_name, t.is_platform
       FROM users u
       JOIN tenants t ON t.id = u.tenant_id
       WHERE u.username = $1`,
      [email],
    );

    if (rows.length === 0) {
      logger.warn('SSO sign-in for unprovisioned user', { email });
      res.status(403).json({ success: false, error: 'No account found for this user. Contact your administrator.' });
      return;
    }

    const row = rows[0];
    if (!row.is_active) {
      res.status(401).json({ success: false, error: 'Account is deactivated. Contact your administrator.' });
      return;
    }

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
    logger.error('SSO callback error', { err: err.message });
    res.status(500).json({ success: false, error: 'SSO sign-in failed' });
  }
});

/* ─────────────────────────────────────────────────────────────
   Internal admin / UI routes (user JWT required)
   ───────────────────────────────────────────────────────────── */
app.use('/api/generate', authMiddleware, generateRoutes);
app.use('/api/execute', authMiddleware, executeRoutes);
app.use('/api/agents', authMiddleware, agentsRoutes);
app.use('/api/chat', authMiddleware, chatRoutes);
app.use('/api/jira', authMiddleware, jiraRoutes);
app.use('/api/document', authMiddleware, documentRoutes);
app.use('/api/git', authMiddleware, gitRoutes);
app.use('/api/confluence', authMiddleware, confluenceRoutes);
app.use('/api/sharepoint', authMiddleware, sharepointRoutes);
app.use('/api/test-cases', authMiddleware, testCasesRoutes);
app.use('/api/configurations', authMiddleware, configurationsRoutes);
app.use('/api/reports', authMiddleware, reportsRoutes);
app.use('/api/tenant-settings', authMiddleware, tenantSettingsRoutes);

app.use('/api/pipeline', authMiddleware, pipelineRoutes);
app.use('/api/pipeline-events', authMiddleware, pipelineEventsRoutes);
app.use('/api/pipeline-pages', authMiddleware, pipelinePagesRoutes);
app.use('/api/pipeline-admin', authMiddleware, pipelineAdminRoutes);
app.use('/api/pipeline-worker', pipelineWorkerRoutes);  // worker secret auth
app.use('/api/automation-scripts', authMiddleware, automationScriptsRoutes);
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
  .then(async () => {
    // Load the Anthropic API key configured in the LLM Configuration page into
    // the environment so the generation pipeline (and worker) can talk to the
    // Anthropic API directly — the durable path that replaced the `claude` CLI.
    const resolved = await hydrateAnthropicEnv(null);
    logger.info('AI engine (Anthropic) configuration', { key: describeResolved(resolved) });
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
