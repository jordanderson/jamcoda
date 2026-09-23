import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { initializeDatabase, closeDatabase } from './config/database';
import syncRoutes from './routes/sync.routes';
import filesRoutes from './routes/files.routes';
import annotationsRoutes from './routes/annotations.routes';
import predictionReviewsRoutes from './routes/predictionReviews.routes';
import settingsRoutes from './routes/settings.routes';
import { loopbackGuard } from './utils/loopbackGuard';

const app = express();
const PORT = Number(process.env.JAMCODA_SERVER_PORT || 3001);
// The desktop app sets this: its server serves the client from its own
// origin, so it listens on loopback only, drops CORS, and refuses requests
// from any other host or origin. Unset, the server listens on every
// interface with open CORS for the Vite dev proxy.
const LOOPBACK_ONLY = process.env.JAMCODA_LOOPBACK_ONLY === '1';

// Middleware
if (LOOPBACK_ONLY) {
  app.use(loopbackGuard(PORT));
} else {
  app.use(cors());
}
app.use(express.json());

// Request logging
app.use((req, _res, next) => {
  console.log(`${req.method} ${req.path}`);
  next();
});

// Initialize database
initializeDatabase();

// Routes
app.use('/api/sync', syncRoutes);
app.use('/api/files', filesRoutes);
app.use('/api/annotations', annotationsRoutes);
app.use('/api/prediction-reviews', predictionReviewsRoutes);
app.use('/api/settings', settingsRoutes);

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// The built client, served from the same origin as /api when
// JAMCODA_CLIENT_DIST_DIR names it (the desktop app). Routing is hash-based
// (#/browse, ...), so serving `index.html` at `/` covers every client route.
const clientDistDir = process.env.JAMCODA_CLIENT_DIST_DIR;
if (clientDistDir && existsSync(path.join(clientDistDir, 'index.html'))) {
  app.use(express.static(clientDistDir));
}

// Error handler
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down gracefully...');
  closeDatabase();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\nShutting down gracefully...');
  closeDatabase();
  process.exit(0);
});

/** Close the database. For a host process that embeds this server. */
export function shutdown(): void {
  closeDatabase();
}

/**
 * Settles once the server is listening, or rejects with the listen error
 * (such as `EADDRINUSE`). Nothing awaits it on the command line, so a failure
 * there is an unhandled rejection that ends the process.
 *
 * Express 5 calls the listen callback for a failure too, with the error.
 */
export const serverReady = new Promise<void>((resolve, reject) => {
  const onListening = (error?: Error) => {
    if (error) {
      reject(error);
      return;
    }
    console.log(`✓ Server running on http://localhost:${PORT}`);
    console.log(`✓ API available at http://localhost:${PORT}/api`);
    resolve();
  };
  if (LOOPBACK_ONLY) {
    app.listen(PORT, '127.0.0.1', onListening);
  } else {
    app.listen(PORT, onListening);
  }
});
