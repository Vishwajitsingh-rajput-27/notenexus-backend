const express = require('express');
const router = express.Router();
const Reminder = require('../models/Reminder');
const { INTERVALS } = require('../models/Reminder');
const auth = require('../middleware/auth');
const { WhatsAppSession } = require('../models/WhatsAppSession');

function nextReminderDate(intervalDays, reminderTime = '09:00') {
  const [hours, minutes] = (reminderTime || '09:00').split(':').map(Number);
  const date = new Date();
  date.setDate(date.getDate() + intervalDays);
  date.setHours(hours, minutes, 0, 0);
  return date;
}

function sameDayDate(reminderTime = '09:00') {
  const [hours, minutes] = (reminderTime || '09:00').split(':').map(Number);
  const date = new Date();
  date.setHours(hours, minutes, 0, 0);
  if (date <= new Date()) {
    date.setDate(date.getDate() + 1);
  }
  return date;
}

// Debug endpoint - NO AUTH required
router.get('/debug-config', async (req, res) => {
  const config = {
    timestamp: new Date().toISOString(),
    email: {
      EMAIL_USER: process.env.EMAIL_USER ? 'SET' : 'MISSING',
      EMAIL_PASS: process.env.EMAIL_PASS ? 'SET' : 'MISSING',
    },
    twilio: {
      TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID ? 'SET' : 'MISSING',
      TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN ? 'SET' : 'MISSING',
      TWILIO_WHATSAPP_NUMBER: process.env.TWILIO_WHATSAPP_NUMBER || 'MISSING',
    },
  };

  if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
    try {
      const nodemailer = require('nodemailer');
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
          user: process.env.EMAIL_USER,
          pass: process.env.EMAIL_PASS,
        },
      });
      await transporter.verify();
      config.email.status = '✅ WORKING';
    } catch (err) {
      config.email.status = `❌ ERROR: ${err.message}`;
    }
  }

  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
    try {
      const twilio = require('twilio');
      const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      const account = await client.api.accounts(process.env.TWILIO_ACCOUNT_SID).fetch();
      config.twilio.status = `✅ WORKING (${account.friendlyName})`;
    } catch (err) {
      config.twilio.status = `❌ ERROR: ${err.message}`;
    }
  }

  try {
    const total = await Reminder.countDocuments({});
    const active = await Reminder.countDocuments({ active: true });
    const due = await Reminder.countDocuments({ active: true, nextReminder: { $lte: new Date() } });
    config.reminders = { total, active, dueNow: due };
  } catch (err) {
    config.reminders = { error: err.message };
  }

  res.json(config);
});

// Test send endpoint
router.post('/test-send', auth, async (req, res) => {
  try {
    const { sendReminder } = require('../services/reminderService');
    const session = await WhatsAppSession.findOne({ userId: req.user._id, isActive: true });

    const testReminder = {
      _id: 'TEST',
      user: req.user._id,
      subject: 'Test Subject',
      topic: 'Test Topic - This is a test!',
      email: req.user.email,
      phone: session?.phone || '',
      intervalDays: 1,
      intervalMinutes: null,
      reminderTime: '09:00',
      isOneShot: true,
      repetitions: 0,
      sendEmail: true,
      sendWhatsApp: !!session?.phone,
    };

    console.log('[TEST] Sending test reminder to:', req.user.email);

    const result = await sendReminder(testReminder);

    res.json({
      success: true,
      message: 'Test reminder sent!',
      sentTo: {
        email: req.user.email,
        whatsapp: session?.phone || 'NOT LINKED',
      },
      result,
    });
  } catch (err) {
    console.error('[TEST] Error:', err);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

// Create reminder
router.post('/', auth, async (req, res) => {
  try {
    const {
      subject, topic, email,
      intervalDays, reminderTime,
      scheduleType, customDate, intervalMinutes,
      sendWhatsApp, phone,
    } = req.body;

    console.log('[Reminder] Creating:', { subject, topic, scheduleType, sendWhatsApp });

    if (!subject || !topic || !email) {
      return res.status(400).json({ error: 'subject, topic, and email are required' });
    }

    const chosenTime = reminderTime || '09:00';
    let isOneShot = false;
    let oneShotAt = null;
    let nextReminder;
    let finalIntervalDays = null;
    let finalIntervalMins = null;

    switch (scheduleType) {
      case 'today':
        isOneShot = true;
        oneShotAt = sameDayDate(chosenTime);
        nextReminder = oneShotAt;
        break;

      case 'custom_date':
        if (!customDate) return res.status(400).json({ error: 'customDate required' });
        isOneShot = true;
        oneShotAt = new Date(customDate);
        if (isNaN(oneShotAt.getTime())) return res.status(400).json({ error: 'Invalid customDate' });
        if (!customDate.includes('T')) {
          const [h, m] = chosenTime.split(':').map(Number);
          oneShotAt.setHours(h, m, 0, 0);
        }
        nextReminder = oneShotAt;
        break;

      case 'interval_minutes':
        finalIntervalMins = Math.max(1, parseInt(intervalMinutes) || 60);
        nextReminder = new Date(Date.now() + finalIntervalMins * 60 * 1000);
        break;

      default:
        finalIntervalDays = Math.max(1, parseInt(intervalDays) || 1);
        nextReminder = new Date();
        break;
    }

    let resolvedPhone = phone || '';
    if (sendWhatsApp && !resolvedPhone) {
      const session = await WhatsAppSession.findOne({ userId: req.user._id, isActive: true });
      if (session) resolvedPhone = session.phone;
    }

    const reminder = await Reminder.create({
      user: req.user.id,
      subject, topic, email,
      phone: resolvedPhone,
      intervalDays: finalIntervalDays,
      intervalMinutes: finalIntervalMins,
      reminderTime: chosenTime,
      isOneShot, oneShotAt, nextReminder,
      sendEmail: true,
      sendWhatsApp: !!sendWhatsApp,
    });

    console.log('[Reminder] ✅ Created:', reminder._id);

    // Send first reminder immediately for repeating
    if (scheduleType === 'repeating' || scheduleType === 'interval_minutes' || !scheduleType) {
      try {
        const { sendReminder } = require('../services/reminderService');
        console.log('[Reminder] Sending first reminder NOW...');

        await sendReminder(reminder);

        reminder.lastSentAt = new Date();
        reminder.repetitions = 1;

        if (finalIntervalMins) {
          reminder.nextReminder = new Date(Date.now() + finalIntervalMins * 60 * 1000);
        } else {
          reminder.nextReminder = nextReminderDate(finalIntervalDays, chosenTime);
        }

        await reminder.save();
        console.log('[Reminder] ✅ First sent, next at:', reminder.nextReminder);

      } catch (err) {
        console.error('[Reminder] ❌ First send failed:', err.message);
      }
    }

    res.status(201).json({ success: true, reminder });

  } catch (err) {
    console.error('[Reminder] POST error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/', auth, async (req, res) => {
  try {
    const reminders = await Reminder.find({ user: req.user.id, active: true }).sort('-createdAt');
    res.json({ reminders });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

router.get('/intervals', auth, (_req, res) => {
  res.json({ intervals: INTERVALS });
});

router.get('/whatsapp-phone', auth, async (req, res) => {
  try {
    const session = await WhatsAppSession.findOne({ userId: req.user._id, isActive: true });
    res.json({
      linked: !!session,
      phone: session?.phone ? session.phone.replace('whatsapp:', '') : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
