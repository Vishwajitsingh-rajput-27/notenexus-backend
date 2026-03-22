const express = require('express');
const router = express.Router();
const Reminder = require('../models/Reminder');
const { INTERVALS } = require('../models/Reminder');
const auth = require('../middleware/auth');

// POST /api/reminders — create a new reminder
router.post('/', auth, async (req, res) => {
  try {
    const { subject, topic, email, phone } = req.body;
    if (!subject || !topic || !email) {
      return res.status(400).json({ error: 'subject, topic, and email are required' });
    }
    const reminder = await Reminder.create({
      user: req.user.id,
      subject, topic, email, phone,
      nextReminder: new Date(), // send first one now (on next cron tick)
    });
    res.status(201).json({ success: true, reminder });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reminders — list user's active reminders
router.get('/', auth, async (req, res) => {
  try {
    const reminders = await Reminder.find({ user: req.user.id, active: true }).sort('-createdAt');
    res.json({ reminders });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/reminders/:id — deactivate
router.delete('/:id', auth, async (req, res) => {
  try {
    const reminder = await Reminder.findOne({ _id: req.params.id, user: req.user.id });
    if (!reminder) return res.status(404).json({ error: 'Reminder not found' });
    reminder.active = false;
    await reminder.save();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reminders/intervals — return the spaced repetition schedule
router.get('/intervals', auth, (_req, res) => {
  res.json({ intervals: INTERVALS, description: 'Days between each repetition' });
});

module.exports = router;
