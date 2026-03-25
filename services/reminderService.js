const cron = require('node-cron');
const nodemailer = require('nodemailer');
const Reminder = require('../models/Reminder');

function log(...args) {
  console.log(`[Reminder ${new Date().toISOString()}]`, ...args);
}

function logError(...args) {
  console.error(`[Reminder ERROR]`, ...args);
}

function checkEmailConfig() {
  const configured = !!(process.env.EMAIL_USER && process.env.EMAIL_PASS);
  if (!configured) log('⚠️ EMAIL NOT CONFIGURED');
  return configured;
}

function checkTwilioConfig() {
  const configured = !!(
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_WHATSAPP_NUMBER
  );
  if (!configured) log('⚠️ TWILIO NOT CONFIGURED');
  return configured;
}

let transporter = null;

function getTransporter() {
  if (!checkEmailConfig()) return null;
  if (!transporter) {
    log('Creating email transporter for:', process.env.EMAIL_USER);
    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });
  }
  return transporter;
}

async function sendWhatsAppMessage(to, body) {
  if (!checkTwilioConfig()) return false;

  const toNum = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
  
  if (toNum === process.env.TWILIO_WHATSAPP_NUMBER) {
    log('⚠️ Skipping WhatsApp - same To and From');
    return false;
  }

  log('📱 Sending WhatsApp to:', toNum);

  try {
    const twilio = require('twilio');
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    
    const message = await client.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: toNum,
      body: body.slice(0, 1600),
    });
    
    log('✅ WhatsApp sent! SID:', message.sid);
    return true;
  } catch (err) {
    logError('❌ WhatsApp failed:', err.message);
    return false;
  }
}

function nextReminderDate(intervalDays, reminderTime = '09:00') {
  const [hours, minutes] = (reminderTime || '09:00').split(':').map(Number);
  const date = new Date();
  date.setDate(date.getDate() + intervalDays);
  date.setHours(hours, minutes, 0, 0);
  return date;
}

function formatTime(val) {
  if (!val) return '09:00 AM';
  const [h, m] = val.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  return `${((h % 12) || 12).toString().padStart(2, '0')}:${m.toString().padStart(2, '0')} ${ampm}`;
}

async function sendEmailReminder(reminder) {
  const transport = getTransporter();
  if (!transport) {
    log('⚠️ Email transporter not available');
    return false;
  }

  log('📧 Sending email to:', reminder.email);

  let scheduleLabel, nextLabel;
  
  if (reminder.intervalMinutes) {
    scheduleLabel = `Every ${reminder.intervalMinutes} minute(s)`;
    nextLabel = `Next in ${reminder.intervalMinutes} minute(s)`;
  } else if (reminder.isOneShot) {
    scheduleLabel = 'One-time reminder';
    nextLabel = 'This was a one-time reminder.';
  } else {
    const days = reminder.intervalDays || 1;
    const time = formatTime(reminder.reminderTime);
    scheduleLabel = `Every ${days} day(s) at ${time}`;
    nextLabel = `Next reminder in ${days} day(s)`;
  }

  const html = `
    <div style="font-family:sans-serif;max-width:520px;margin:0 auto;background:#0f172a;color:#e2e8f0;border-radius:12px;overflow:hidden">
      <div style="background:linear-gradient(135deg,#1e40af,#7c3aed);padding:28px 32px">
        <h1 style="margin:0;font-size:24px;color:#fff">📚 NoteNexus</h1>
        <p style="margin:6px 0 0;color:#bfdbfe;font-size:14px">Revision Reminder</p>
      </div>
      <div style="padding:32px">
        <h2 style="margin:0 0 8px;color:#f8fafc">Time to revise!</h2>
        <div style="background:#1e293b;border-radius:8px;padding:20px;margin-bottom:24px">
          <p style="margin:0 0 8px"><strong style="color:#60a5fa">Subject:</strong> <span style="color:#f1f5f9">${reminder.subject}</span></p>
          <p style="margin:0 0 8px"><strong style="color:#60a5fa">Topic:</strong> <span style="color:#f1f5f9">${reminder.topic}</span></p>
          <p style="margin:0 0 8px"><strong style="color:#60a5fa">Repetition #:</strong> <span style="color:#4ade80">${(reminder.repetitions || 0) + 1}</span></p>
          <p style="margin:0"><strong style="color:#60a5fa">Schedule:</strong> <span style="color:#f1f5f9">${scheduleLabel}</span></p>
        </div>
        <p style="color:#94a3b8;font-size:13px">${nextLabel}</p>
        <a href="${process.env.FRONTEND_URL || 'https://notenexus.vercel.app'}"
           style="display:inline-block;background:#2563eb;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;margin-top:16px">
          Open NoteNexus →
        </a>
      </div>
    </div>
  `;

  try {
    const info = await transport.sendMail({
      from: `"NoteNexus" <${process.env.EMAIL_USER}>`,
      to: reminder.email,
      subject: `📚 Revision time: ${reminder.topic} (${reminder.subject})`,
      html,
    });

    log('✅ Email sent! Message ID:', info.messageId);
    return true;
  } catch (err) {
    logError('❌ Email failed:', err.message);
    return false;
  }
}

async function sendWhatsAppReminder(reminder) {
  if (!reminder.sendWhatsApp) {
    log('WhatsApp not enabled for this reminder');
    return false;
  }
  
  if (!reminder.phone) {
    log('⚠️ WhatsApp enabled but no phone number');
    return false;
  }

  log('📱 Preparing WhatsApp reminder to:', reminder.phone);

  let scheduleLabel, nextLabel;
  
  if (reminder.intervalMinutes) {
    scheduleLabel = `Every ${reminder.intervalMinutes} min`;
    nextLabel = `Next in ${reminder.intervalMinutes} min`;
  } else if (reminder.isOneShot) {
    scheduleLabel = 'One-time';
    nextLabel = 'This was a one-time reminder.';
  } else {
    const days = reminder.intervalDays || 1;
    scheduleLabel = `Every ${days} day(s)`;
    nextLabel = `Next in ${days} day(s)`;
  }

  const msg = [
    `📚 *NoteNexus Reminder*`,
    ``,
    `📖 *Subject:* ${reminder.subject}`,
    `🎯 *Topic:* ${reminder.topic}`,
    `🔁 *Schedule:* ${scheduleLabel}`,
    `✅ *Repetition #${(reminder.repetitions || 0) + 1}*`,
    ``,
    nextLabel,
    ``,
    `🌐 ${process.env.FRONTEND_URL || 'https://notenexus.vercel.app'}`,
  ].join('\n');

  return await sendWhatsAppMessage(reminder.phone, msg);
}

async function sendReminder(reminder) {
  log('═══════════════════════════════════════════════════════');
  log('📤 SENDING REMINDER');
  log('Topic:', reminder.topic);
  log('Subject:', reminder.subject);
  log('Email:', reminder.email);
  log('Phone:', reminder.phone || 'NOT SET');
  log('Send Email:', reminder.sendEmail !== false);
  log('Send WhatsApp:', reminder.sendWhatsApp);
  log('═══════════════════════════════════════════════════════');

  const results = { email: false, whatsapp: false };

  if (reminder.sendEmail !== false) {
    results.email = await sendEmailReminder(reminder);
  }

  if (reminder.sendWhatsApp && reminder.phone) {
    results.whatsapp = await sendWhatsAppReminder(reminder);
  }

  log('📊 Results:', results);
  return results;
}

function startReminderCron() {
  log('═══════════════════════════════════════════════════════');
  log('📋 REMINDER SERVICE STARTING');
  log('Email configured:', checkEmailConfig());
  log('Twilio configured:', checkTwilioConfig());
  log('═══════════════════════════════════════════════════════');

  cron.schedule('* * * * *', async () => {
    try {
      const now = new Date();
      
      const due = await Reminder.find({
        active: true,
        nextReminder: { $lte: now },
      });

      if (due.length === 0) return;

      log('═══════════════════════════════════════════════════════');
      log(`⏰ CRON TICK: ${now.toISOString()}`);
      log(`📋 Found ${due.length} due reminder(s)`);
      log('═══════════════════════════════════════════════════════');

      for (const reminder of due) {
        log(`\n🔔 Processing: "${reminder.topic}" (ID: ${reminder._id})`);

        try {
          await sendReminder(reminder);

          reminder.lastSentAt = now;
          reminder.repetitions = (reminder.repetitions || 0) + 1;

          if (reminder.isOneShot) {
            reminder.active = false;
            log('✅ One-shot completed, deactivated');
          } else {
            if (reminder.intervalMinutes) {
              reminder.nextReminder = new Date(now.getTime() + reminder.intervalMinutes * 60 * 1000);
              log(`⏭️ Next in ${reminder.intervalMinutes} min`);
            } else {
              const days = reminder.intervalDays || 1;
              reminder.nextReminder = nextReminderDate(days, reminder.reminderTime);
              log(`⏭️ Next in ${days} day(s)`);
            }
          }

          await reminder.save();
          log('✅ Reminder state saved');

        } catch (err) {
          logError(`Failed to process reminder ${reminder._id}:`, err.message);
        }
      }

      log('\n✅ Cron cycle complete\n');

    } catch (err) {
      logError('Cron error:', err.message);
    }
  });

  console.log('✅ Revision reminder cron started (runs every minute)');
}

module.exports = {
  startReminderCron,
  sendReminder,
  sendEmailReminder,
  sendWhatsAppReminder,
  sendWhatsAppMessage,
};
