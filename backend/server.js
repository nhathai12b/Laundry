import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import helmet from 'helmet';
import db from './database/db.js';

// Import routes
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import productRoutes from './routes/products.js';
import customerRoutes from './routes/customers.js';
import orderRoutes from './routes/orders.js';
import timesheetRoutes from './routes/timesheets.js';
import reportRoutes from './routes/reports.js';
import settingsRoutes from './routes/settings.js';
import printRoutes from './routes/print.js';
import storeRoutes from './routes/stores.js';
import employeeRoutes from './routes/employees.js';
import promotionRoutes from './routes/promotions.js';
import zaloRoutes from './routes/zalo.js';
import cashDrawerRoutes from './routes/cashDrawer.js';
import sheetsRoutes from './routes/sheets.js';
import { getMemoryUsageFormatted } from './utils/memoryMonitor.js';
import { duplicateRequestGuard } from './middleware/duplicateRequestGuard.js';

dotenv.config();

// Validate JWT secret before accepting any traffic — a missing/placeholder/short
// secret makes every session token forgeable
const WEAK_JWT_SECRETS = ['change_this_to_a_strong_random_value', 'secret', 'jwt_secret', 'changeme'];
const jwtSecret = process.env.JWT_SECRET || '';
if (!jwtSecret || jwtSecret.length < 32 || WEAK_JWT_SECRETS.includes(jwtSecret)) {
  if (process.env.NODE_ENV === 'production') {
    console.error('❌ JWT_SECRET is missing, too short (<32 chars), or a known placeholder.');
    console.error('💡 Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"');
    process.exit(1);
  } else {
    console.warn('⚠️  JWT_SECRET is weak or a placeholder — tokens are forgeable. Set a strong value in .env before deploying.');
  }
}

const app = express();
const PORT = process.env.PORT || 5000;
const duplicateGuard = duplicateRequestGuard();

// Behind a reverse proxy (nginx on VPS), req.ip is the proxy address unless
// trust proxy is set — which would make per-IP rate limiting and login lockout
// share one bucket for ALL clients. Enable only when actually behind a proxy,
// since trusting X-Forwarded-For from direct clients lets them spoof their IP.
if (process.env.TRUST_PROXY === 'true') {
  app.set('trust proxy', 1);
}

// Security Headers - Bảo vệ khỏi XSS, clickjacking, MIME sniffing
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
  crossOriginEmbedderPolicy: false, // Cho phép CORS
}));

// Middleware - CORS configuration
const corsOptions = {
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
};

// In development, allow all localhost origins
if (process.env.NODE_ENV === 'production') {
  // Production: only allow specific FRONTEND_URL
  corsOptions.origin = process.env.FRONTEND_URL || 'http://localhost:3000';
} else {
  // Development: allow all localhost origins
  corsOptions.origin = (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    // Allow all localhost and 127.0.0.1 origins in development
    if (origin.match(/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/)) {
      return callback(null, true);
    }
    
    // Also allow FRONTEND_URL if specified
    if (process.env.FRONTEND_URL && origin === process.env.FRONTEND_URL) {
      return callback(null, true);
    }
    
    callback(null, true); // Allow all in development
  };
}

app.use(cors(corsOptions));
app.use(express.json({ limit: '500kb' }));
app.use(express.urlencoded({ extended: true, limit: '500kb' }));

// Block accidental duplicate submissions (double-clicked "OK" buttons):
// identical mutating requests within a short window replay the first response
// instead of creating duplicate records. Excluded:
//  - auth: own protections
//  - integrations: external webhooks with own retry semantics
//  - payments: two legitimate instalments of the same amount are common and
//    MUST both record — collapsing them would short the cash drawer
//  - print: replaying "sent to printer" without actually printing loses a bill
const DUPLICATE_GUARD_SKIP = ['/auth/', '/integrations/', '/print/'];
app.use('/api', (req, res, next) => {
  if (DUPLICATE_GUARD_SKIP.some((p) => req.path.startsWith(p))) return next();
  if (/^\/orders\/\d+\/payments$/.test(req.path)) return next();
  return duplicateGuard(req, res, next);
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/products', productRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/timesheets', timesheetRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/print', printRoutes);
app.use('/api/stores', storeRoutes);
app.use('/api/employees', employeeRoutes);
app.use('/api/promotions', promotionRoutes);
app.use('/api/zalo', zaloRoutes);
app.use('/api/cash-drawer', cashDrawerRoutes);
app.use('/api/integrations/sheets', sheetsRoutes);

// Health check
app.get('/api/health', (req, res) => {
  const memory = getMemoryUsageFormatted();
  const uptime = Math.round(process.uptime());
  
  res.json({ 
    status: 'ok', 
    database: 'connected',
    memory,
    uptime: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
    timestamp: new Date().toISOString()
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`✅ Database: ${process.env.MYSQL_DATABASE || 'laundry66'} @ ${process.env.MYSQL_HOST || 'localhost'}`);
  console.log(`✅ CORS enabled for: ${process.env.FRONTEND_URL || 'http://localhost:3000'}`);
  console.log(`✅ Health check: http://localhost:${PORT}/api/health`);
});

// Handle server errors
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});
