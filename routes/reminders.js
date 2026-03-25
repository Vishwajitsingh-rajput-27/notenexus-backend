const express  = require('express');
const router   = express.Router();
const Reminder = require('../models/Reminder');
const { INTERVALS } = require('../models/Reminder');
const auth     = require('../middleware/auth');
const { WhatsAppSession } = require('../models/WhatsAppSession');

// ─── Date helpers ─────────────────────────────────────────────────────────────

function nextReminderDate(intervalDays, reminderTime = '09:00') {
  const [hours, minutes] = (reminderTime || '09:00').split(':').map(Number);
  const date = new Date();
  date.setDate(date.getDate() + intervalDays);
  date.setHours(hours, minutes, 0, 0);
  return date;
}

// Build a Date for same-day delivery at a specific HH:MM
// If the time has already passed today, schedule for the same time tomorrow
function sameDayDate(reminderTime = '09:00') {
  const [hours, minutes] = (reminderTime || '09:00').split(':').map(Number);
  const date = new Date();
  date.setHours(hours, minutes, 0, 0);
  if (date <= new Date()) {
    date.setDate(date.getDate() + 1); // already past — send tomorrow
  }
  return date;
}

// ─── POST /api/reminders — create a new reminder ──────────────────────────────

router.post('/', auth, async (req, res) => {
  try {
    const {
      subject, topic, email,
      intervalDays, reminderTime,
      // New fields
      scheduleType,   // 'repeating' | 'today' | 'custom_date' | 'interval_minutes'
      customDate,     // ISO date string for one-shot on a specific date
      intervalMinutes,// number — for minute-level intervals (e.g. every 30 min)
      sendWhatsApp,   // bool
      // WhatsApp phone override (if user hasn't linked their account yet)
      phone,
    } = req.body;

    if (!subject || !topic || !email) {
      return res.status(400).json({ error: 'subject, topic, and email are required' });
    }

    const chosenTime = reminderTime || '09:00';
    let isOneShot    = false;
    let oneShotAt    = null;
    let nextReminder;
    let finalIntervalDays = Math.max(1, parseInt(intervalDays) || 1);
    let finalIntervalMins = null;

    switch (scheduleType) {
      case 'today':
        // Fire once today (or tomorrow if time passed)
        isOneShot    = true;
        oneShotAt    = sameDayDate(chosenTime);
        nextReminder = oneShotAt;
        break;

      case 'custom_date':
        // Fire once at a user-supplied date + time
        if (!customDate) return res.status(400).json({ error: 'customDate required for custom_date schedule' });
        isOneShot    = true;
        oneShotAt    = new Date(customDate);
        if (isNaN(oneShotAt.getTime())) return res.status(400).json({ error: 'Invalid customDate' });
        // Apply the time component from reminderTime if customDate is date-only
        if (!customDate.includes('T')) {
          const [h, m] = chosenTime.split(':').map(Number);
          oneShotAt.setHours(h, m, 0, 0);
        }
        nextReminder = oneShotAt;
        break;

      case 'interval_minutes':
        // Repeating every N minutes — for very short intervals (e.g. study sprints)
        finalIntervalMins = Math.max(1, parseInt(intervalMinutes) || 60);
        nextReminder = new Date(Date.now() + finalIntervalMins * 60 * 1000);
        finalIntervalDays = 0; // not day-based
        break;

      default:
        // 'repeating' — standard day-based interval, send first one immediately
        nextReminder = new Date();
        break;
    }

    // Resolve WhatsApp phone from linked session if not provided
    let resolvedPhone = phone || '';
    if (sendWhatsApp && !resolvedPhone) {
      const session = await WhatsAppSession.findOne({ userId: req.user._id });
      if (session) resolvedPhone = session.phone;
    }

    const reminder = await Reminder.create({
      user: req.user.id,
      subject, topic, email,
      phone: resolvedPhone,
      intervalDays: finalIntervalDays,
      reminderTime: chosenTime,
      isOneShot,
      oneShotAt,
      nextReminder,
      sendEmail: true,
      sendWhatsApp: !!sendWhatsApp,
      // Store intervalMinutes in a virtual way via a custom field on the doc
      ...(finalIntervalMins ? { _intervalMinutes: finalIntervalMins } : {}),
    });

    // For minute-based intervals, store it so cron can re-schedule correctly
    if (finalIntervalMins) {
      reminder.set('intervalMinutes', finalIntervalMins, { strict: false });
    }

    // Send the first reminder immediately for repeating reminders
    if (scheduleType !== 'today' && scheduleType !== 'custom_date') {
      try {
        const { sendReminder } = require('../services/reminderService');
        await sendReminder(reminder);
        reminder.lastSentAt  = new Date();
        reminder.repetitions = 1;
        // Schedule next
        if (finalIntervalMins) {
          reminder.nextReminder = new Date(Date.now() + finalIntervalMins * 60 * 1000);
        } else {
          reminder.nextReminder = nextReminderDate(finalIntervalDays, chosenTime);
        }
        await reminder.save();
      } catch (mailErr) {
        console.error('[Reminder] First-send failed:', mailErr.message);
      }
    } else {
      await reminder.save();
    }

    res.status(201).json({ success: true, reminder });
  } catch (err) {
    console.error('[reminders] POST error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/reminders ───────────────────────────────────────────────────────

router.get('/', auth, async (req, res) => {
  try {
    const reminders = await Reminder.find({ user: req.user.id, active: true }).sort('-createdAt');
    res.json({ reminders });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/reminders/:id ────────────────────────────────────────────────

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

// ─── GET /api/reminders/intervals ────────────────────────────────────────────

router.get('/intervals', auth, (_req, res) => {
  res.json({ intervals: INTERVALS, description: 'Days between each repetition' });
});

// ─── GET /api/reminders/whatsapp-phone ───────────────────────────────────────
// Returns the linked WhatsApp phone for the current user (to pre-fill UI)

router.get('/whatsapp-phone', auth, async (req, res) => {
  try {
    const session = await WhatsAppSession.findOne({ userId: req.user._id });
    res.json({
      linked: !!session,
      phone: session?.phone ? session.phone.replace('whatsapp:', '') : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
