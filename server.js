require('dotenv').config();

const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
dns.setServers(['8.8.8.8', '8.8.4.4']);

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');
const helmet     = require('helmet');
const morgan     = require('morgan');
const connectDB  = require('./config/db');
const setupSocket = require('./socket');

// Routes
const authRoutes     = require('./routes/auth');
const notesRoutes    = require('./routes/notes');
const whatsappRoutes = require('./routes/whatsapp');
const examRoutes     = require('./routes/examPredictor');
const plannerRoutes  = require('./routes/studyPlanner');
const reminderRoutes = require('./routes/reminders');
const tutorRoutes    = require('./routes/tutor');
const searchRoutes   = require('./routes/search');
const revisionRoutes = require('./routes/revision');
const savedItemsRoutes = require('./routes/savedItems');

// Services
const { startReminderCron } = require('./services/reminderService');

const app    = express();
const server = http.createServer(app);

// ═══════════════════════════════════════════════════════════════════════════════
// CORS - ALLOW EVERYTHING
// ═══════════════════════════════════════════════════════════════════════════════

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,PATCH,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept');
  res.header('Access-Control-Allow-Credentials', 'false');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(cors({ origin: '*', credentials: false }));

// ═══════════════════════════════════════════════════════════════════════════════
// SOCKET.IO
// ═══════════════════════════════════════════════════════════════════════════════

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

// ═══════════════════════════════════════════════════════════════════════════════
// MIDDLEWARE
// ═══════════════════════════════════════════════════════════════════════════════

app.use(helmet({ 
  crossOriginResourcePolicy: false, 
  contentSecurityPolicy: false 
}));
app.use(morgan('dev'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

app.use('/api/auth',     authRoutes);
app.use('/api/notes',    notesRoutes);
app.use('/api/whatsapp', whatsappRoutes);
app.use('/api/exam',     examRoutes);
app.use('/api/planner',  plannerRoutes);
app.use('/api/reminders', reminderRoutes);
app.use('/api/tutor',    tutorRoutes);
app.use('/api/search',   searchRoutes);
app.use('/api/revision', revisionRoutes);
app.use('/api/saved',    savedItemsRoutes);

app.get('/', (req, res) => res.json({ 
  message: 'NoteNexus API running! 📚', 
  version: '1.0.0',
  timestamp: new Date().toISOString(),
}));

// ═══════════════════════════════════════════════════════════════════════════════
// SOCKET SETUP
// ═══════════════════════════════════════════════════════════════════════════════

setupSocket(io);

// ═══════════════════════════════════════════════════════════════════════════════
// ERROR HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

app.use((err, req, res, next) => {
  console.error('Express error:', err.stack);
  res.status(err.status || 500).json({ 
    message: err.message || 'Internal server error',
    error: process.env.NODE_ENV === 'development' ? err.stack : undefined,
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SERVER STARTUP
// ═══════════════════════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 5000;

async function startServer() {
  try {
    // Connect to MongoDB first
    await connectDB();
    console.log('✅ MongoDB connected successfully');

    // Start the reminder cron job AFTER DB connection is ready
    startReminderCron();

    // Start HTTP server
    server.listen(PORT, () => {
      console.log(`🚀 NoteNexus server running on port ${PORT}`);
      console.log(`📡 Environment: ${process.env.NODE_ENV || 'development'}`);
    });

  } catch (err) {
    console.error('❌ Server startup failed:', err);
    process.exit(1);
  }
}

// Start the server
startServer();
