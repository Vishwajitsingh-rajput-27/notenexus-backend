const express = require('express');
const jwt     = require('jsonwebtoken');
const asyncHandler = require('express-async-handler');
const User    = require('../models/User');
const { protect } = require('../middleware/auth');

const router = express.Router();

const signToken = (id) => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRE || '7d' });

// POST /api/auth/register
router.post('/register', asyncHandler(async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ message: 'All fields required' });
  if (await User.findOne({ email })) return res.status(400).json({ message: 'Email already registered' });
  const user = await User.create({ name, email, password });
  res.status(201).json({ token: signToken(user._id), user: { id: user._id, name: user.name, email: user.email } });
}));

// POST /api/auth/login
router.post('/login', asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ message: 'Email and password required' });
  const user = await User.findOne({ email });
  if (!user || !(await user.matchPassword(password))) return res.status(401).json({ message: 'Invalid email or password' });
  res.json({ token: signToken(user._id), user: { id: user._id, name: user.name, email: user.email } });
}));

// GET /api/auth/me
router.get('/me', protect, asyncHandler(async (req, res) => {
  res.json({ id: req.user._id, name: req.user.name, email: req.user.email });
}));

module.exports = router;
