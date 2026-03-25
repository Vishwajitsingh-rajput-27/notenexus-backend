const express = require('express');
const router = express.Router();
const Reminder = require('../models/Reminder');
const { INTERVALS } = require('../models/Reminder');
const auth = require('../middleware/auth');
const { WhatsAppSession } = require('../models/WhatsAppSession');

// ═══════════════════════════════════════════════════════════════════════════════
// DATE HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

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
  
  // If the time has already passed today, use tomorrow
  if (date <= new Date()) {
    date.setDate(date.getDate() + 1);
  }
  
  return date;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEBUG ENDPOINTS (NO AUTH REQUIRED)
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/debug-config', async (req, res) => {
  const config = {
    timestamp: new Date().toISOString(),
    email: {
      EMAIL_USER: process.env.EMAIL_USER ? `SET (${process.env.EMAIL_USER})` : 'MISSING',
      EMAIL_PASS: process.env.EMAIL_PASS ? 'SET' : 'MISSING',
    },
    twilio: {
      TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID ? `SET (${process.env.TWILIO_ACCOUNT_SID.slice(0, 8)}...)` : 'MISSING',
      TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN ? 'SET' : 'MISSING',
      TWILIO_WHATSAPP_NUMBER: process.env.TWILIO_WHATSAPP_NUMBER || 'MISSING',
    },
  };

  // Test email connection
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
      config.email.status = '✅ VERIFIED - Ready to send';
    } catch (err) {
      config.email.status = `❌ ERROR: ${err.message}`;
    }
  } else {
    config.email.status = '❌ NOT CONFIGURED';
  }

  // Test Twilio connection
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
    try {
      const twilio = require('twilio');
      const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      const account = await client.api.accounts(process.env.TWILIO_ACCOUNT_SID).fetch();
      config.twilio.status = `✅ VERIFIED - ${account.friendlyName}`;
    } catch (err) {
      config.twilio.status = `❌ ERROR: ${err.message}`;
    }
  } else {
    config.twilio.status = '❌ NOT CONFIGURED';
  }

  // Count reminders
  try {
    const total = await Reminder.countDocuments({});
    const active = await Reminder.countDocuments({ active: true });
    const due = await Reminder.countDocuments({ 
      active: true, 
      nextReminder: { $lte: new Date() } 
    });
    
    config.reminders = { 
      total, 
      active, 
      dueNow: due,
      message: due > 0 ? `${due} reminder(s) ready to send!` : 'No reminders due'
    };
  } catch (err) {
    config.reminders = { error: err.message };
  }

  res.json(config);
});

// ═══════════════════════════════════════════════════════════════════════════════
// TEST SEND ENDPOINT (AUTH REQUIRED)
// ═══════════════════════════════════════════════════════════════════════════════

router.post('/test-send', auth, async (req, res) => {
  try {
    const { sendReminder } = require('../services/reminderService');
    const session = await WhatsAppSession.findOne({ 
      userId: req.user._id, 
      isActive: true 
    });

    const testReminder = {
      _id: 'TEST-REMINDER',
      user: req.user._id,
      subject: 'Test Subject',
      topic: 'Test Reminder - This is a manual test!',
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
      message: 'Test reminder sent! Check your email and WhatsApp.',
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
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// CREATE REMINDER
// ═══════════════════════════════════════════════════════════════════════════════

router.post('/', auth, async (req, res) => {
  try {
    const {
      subject,
      topic,
      email,
      intervalDays,
      reminderTime,
      scheduleType,
      customDate,
      intervalMinutes,
      sendWhatsApp,
      phone,
    } = req.body;

    console.log('[Reminder] Creating reminder:', {
      subject,
      topic,
      scheduleType,
      intervalDays,
      intervalMinutes,
      sendWhatsApp,
    });

    // Validation
    if (!subject || !topic || !email) {
      return res.status(400).json({ 
        error: 'Missing required fields: subject, topic, and email are required' 
      });
    }

    const chosenTime = reminderTime || '09:00';
    let isOneShot = false;
    let oneShotAt = null;
    let nextReminder;
    let finalIntervalDays = null;
    let finalIntervalMins = null;

    // Determine schedule based on type
    switch (scheduleType) {
      case 'today':
        isOneShot = true;
        oneShotAt = sameDayDate(chosenTime);
        nextReminder = oneShotAt;
        
        // FIX: If time has passed, send immediately
        if (nextReminder <= new Date()) {
          nextReminder = new Date();
        }
        
        console.log('[Reminder] Schedule: TODAY at', nextReminder.toISOString());
        break;

      case 'custom_date':
        if (!customDate) {
          return res.status(400).json({ error: 'customDate is required for custom_date schedule' });
        }
        isOneShot = true;
        oneShotAt = new Date(customDate);
        
        if (isNaN(oneShotAt.getTime())) {
          return res.status(400).json({ error: 'Invalid customDate format' });
        }
        
        // Apply time if only date was provided
        if (!customDate.includes('T')) {
          const [h, m] = chosenTime.split(':').map(Number);
          oneShotAt.setHours(h, m, 0, 0);
        }
        
        nextReminder = oneShotAt;
        console.log('[Reminder] Schedule: CUSTOM DATE at', nextReminder.toISOString());
        break;

      case 'interval_minutes':
        finalIntervalMins = Math.max(1, parseInt(intervalMinutes) || 60);
        nextReminder = new Date(Date.now() + finalIntervalMins * 60 * 1000);
        console.log('[Reminder] Schedule: Every', finalIntervalMins, 'minutes, first at', nextReminder.toISOString());
        break;

      default:
        // 'repeating' or no type specified - send first one immediately
        finalIntervalDays = Math.max(1, parseInt(intervalDays) || 1);
        nextReminder = new Date(); // Send NOW
        console.log('[Reminder] Schedule: REPEATING every', finalIntervalDays, 'days, sending first one NOW');
        break;
    }

    // Get WhatsApp phone number
    let resolvedPhone = phone || '';
    if (sendWhatsApp && !resolvedPhone) {
      const session = await WhatsAppSession.findOne({ 
        userId: req.user._id, 
        isActive: true 
      });
      
      if (session) {
        resolvedPhone = session.phone;
        console.log('[Reminder] Using linked WhatsApp phone:', resolvedPhone);
      } else {
        console.log('[Reminder] ⚠️ WhatsApp enabled but no linked session found');
      }
    }

    // Create the reminder
    const reminder = await Reminder.create({
      user: req.user.id,
      subject,
      topic,
      email,
      phone: resolvedPhone,
      intervalDays: finalIntervalDays,
      intervalMinutes: finalIntervalMins,
      reminderTime: chosenTime,
      isOneShot,
      oneShotAt,
      nextReminder,
      sendEmail: true,
      sendWhatsApp: !!sendWhatsApp,
    });

    console.log('[Reminder] ✅ Reminder created with ID:', reminder._id);

    // Send first reminder immediately for repeating and minute-based reminders
    if (scheduleType === 'repeating' || scheduleType === 'interval_minutes' || !scheduleType) {
      try {
        const { sendReminder } = require('../services/reminderService');
        console.log('[Reminder] Sending first reminder immediately...');

        await sendReminder(reminder);

        // Update reminder state after first send
        reminder.lastSentAt = new Date();
        reminder.repetitions = 1;

        // Schedule next occurrence
        if (finalIntervalMins) {
          reminder.nextReminder = new Date(Date.now() + finalIntervalMins * 60 * 1000);
        } else {
          reminder.nextReminder = nextReminderDate(finalIntervalDays, chosenTime);
        }

        await reminder.save();
        console.log('[Reminder] ✅ First reminder sent, next scheduled for:', reminder.nextReminder.toISOString());

      } catch (err) {
        console.error('[Reminder] ❌ Failed to send first reminder:', err.message);
        // Don't fail the entire request if first send fails
      }
    }

    res.status(201).json({ 
      success: true, 
      reminder,
      message: scheduleType === 'today' || scheduleType === 'custom_date' 
        ? `Reminder scheduled for ${nextReminder.toLocaleString()}`
        : 'Reminder created and first notification sent!'
    });

  } catch (err) {
    console.error('[Reminder] POST error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET ALL ACTIVE REMINDERS
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/', auth, async (req, res) => {
  try {
    const reminders = await Reminder.find({
      user: req.user.id,
      active: true,
    }).sort('-createdAt');

    res.json({ reminders });
  } catch (err) {
    console.error('[Reminder] GET error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// DELETE/CANCEL REMINDER
// ═══════════════════════════════════════════════════════════════════════════════

router.delete('/:id', auth, async (req, res) => {
  try {
    const reminder = await Reminder.findOne({
      _id: req.params.id,
      user: req.user.id,
    });

    if (!reminder) {
      return res.status(404).json({ error: 'Reminder not found' });
    }

    reminder.active = false;
    await reminder.save();

    console.log('[Reminder] Reminder cancelled:', req.params.id);
    res.json({ success: true, message: 'Reminder cancelled successfully' });
  } catch (err) {
    console.error('[Reminder] DELETE error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET PRESET INTERVALS
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/intervals', auth, (_req, res) => {
  res.json({
    intervals: INTERVALS,
    description: 'Preset spaced-repetition intervals in days',
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET LINKED WHATSAPP PHONE
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/whatsapp-phone', auth, async (req, res) => {
  try {
    const session = await WhatsAppSession.findOne({
      userId: req.user._id,
      isActive: true,
    });

    res.json({
      linked: !!session,
      phone: session?.phone ? session.phone.replace('whatsapp:', '') : null,
    });
  } catch (err) {
    console.error('[Reminder] whatsapp-phone error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
