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
const searchRoutes   = require('./routes/search');
const revisionRoutes = require('./routes/revision');

// ── App setup ──────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

const FRONTEND = process.env.FRONTEND_URL || 'http://localhost:3000';

const io = new Server(server, {
  cors: { origin: [FRONTEND, 'http://localhost:3000', 'http://localhost:3001'], methods: ['GET', 'POST'], credentials: true },
});

// ── Middleware ─────────────────────────────────────────────────────────────
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors({ origin: [FRONTEND, 'http://localhost:3000', 'http://localhost:3001'], credentials: true }));
app.use(morgan('dev'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Routes ─────────────────────────────────────────────────────────────────
app.use('/api/auth',     authRoutes);
app.use('/api/notes',    notesRoutes);
app.use('/api/search',   searchRoutes);
app.use('/api/revision', revisionRoutes);

app.get('/', (req, res) => res.json({ message: 'NoteNexus API running! 📚', version: '1.0.0', docs: '/api' }));

// ── Socket.io ──────────────────────────────────────────────────────────────
setupSocket(io);

// ── Error handler ──────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({ message: err.message || 'Server error' });
});

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
connectDB().then(() => {
  server.listen(PORT, () => console.log(`🚀 NoteNexus server running on port ${PORT}`));
});
