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
import { getMemoryUsageFormatted } from './utils/memoryMonitor.js';

dotenv.config();

// Warn loudly (without aborting an already-working deployment) on missing/
// weak critical configuration, since these silently break auth or CORS.
if (!process.env.JWT_SECRET) {
  console.error('❌ JWT_SECRET is not set. All login/token verification will fail.');
} else if (process.env.JWT_SECRET.length < 32) {
  console.warn('⚠️  JWT_SECRET is shorter than 32 characters. Use a longer, random secret in production.');
}
if (process.env.NODE_ENV === 'production' && !process.env.FRONTEND_URL) {
  console.warn('⚠️  FRONTEND_URL is not set in production; CORS will fall back to http://localhost:3000.');
}

const app = express();
const PORT = process.env.PORT || 5000;

// Deployed behind a single Nginx reverse proxy (system Nginx on the VPS, or
// the frontend container in docker-compose.yml) which sets X-Forwarded-For.
// Without this, req.ip resolves to the proxy's own address (127.0.0.1) for
// every request, collapsing per-IP
// login rate limiting/lockout into one shared bucket for all users.
app.set('trust proxy', 1);

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
  allowedHeaders: ['Content-Type', 'Authorization'],
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
  if (res.headersSent) {
    return next(err);
  }
  res.status(err.status || 500).json({ error: 'Internal server error' });
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

