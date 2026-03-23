const express = require('express');
const router = express.Router();
const Reminder = require('../models/Reminder');
const { INTERVALS } = require('../models/Reminder');
const auth = require('../middleware/auth');

// Helper: build the next Date for a given HH:MM time string, N days from now
function nextReminderDate(intervalDays, reminderTime = '09:00') {
  const [hours, minutes] = reminderTime.split(':').map(Number);
  const date = new Date();
  date.setDate(date.getDate() + intervalDays);
  date.setHours(hours, minutes, 0, 0);
  return date;
}

// POST /api/reminders — create a new reminder
router.post('/', auth, async (req, res) => {
  try {
    const { subject, topic, email, phone, intervalDays, reminderTime } = req.body;
    if (!subject || !topic || !email) {
      return res.status(400).json({ error: 'subject, topic, and email are required' });
    }

    const chosenInterval = Math.max(1, parseInt(intervalDays) || 1);
    const chosenTime     = reminderTime || '09:00';

    const reminder = await Reminder.create({
      user: req.user.id,
      subject, topic, email,
      phone: phone || '',
      intervalDays: chosenInterval,
      reminderTime: chosenTime,
      nextReminder: new Date(), // send first one immediately
    });

    // Send the first email right now — don't wait for cron
    try {
      const { sendEmailReminder } = require('../services/reminderService');
      await sendEmailReminder(reminder);
      reminder.lastSentAt  = new Date();
      reminder.repetitions = 1;
      reminder.nextReminder = nextReminderDate(chosenInterval, chosenTime);
      await reminder.save();
    } catch (mailErr) {
      console.error('[Reminder] First-send failed:', mailErr.message);
      // Still succeed — reminder saved, cron will retry
    }

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

// GET /api/reminders/intervals — return the preset schedule options
router.get('/intervals', auth, (_req, res) => {
  res.json({ intervals: INTERVALS, description: 'Days between each repetition' });
});

module.exports = router;
