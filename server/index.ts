import express from 'express';
import cors from 'cors';
import { initializeDatabase, closeDatabase } from './config/database';
import syncRoutes from './routes/sync.routes';
import filesRoutes from './routes/files.routes';
import annotationsRoutes from './routes/annotations.routes';
import predictionReviewsRoutes from './routes/predictionReviews.routes';
import ignoredSectionsRoutes from './routes/ignoredSections.routes';

const app = express();
const PORT = Number(process.env.JAMCODA_SERVER_PORT || 3001);

// Middleware
app.use(cors());
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
app.use('/api/ignored-sections', ignoredSectionsRoutes);

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

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

app.listen(PORT, () => {
  console.log(`✓ Server running on http://localhost:${PORT}`);
  console.log(`✓ API available at http://localhost:${PORT}/api`);
});
