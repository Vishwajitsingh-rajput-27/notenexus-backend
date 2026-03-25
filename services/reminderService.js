const cron       = require('node-cron');
const nodemailer = require('nodemailer');
const Reminder   = require('../models/Reminder');

// ─── Email transporter ────────────────────────────────────────────────────────

function getTransporter() {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.warn('[Reminder] ⚠️  EMAIL_USER or EMAIL_PASS not set — emails will NOT send!');
    return null;
  }
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
  });
}

// ─── Twilio WhatsApp helper ───────────────────────────────────────────────────

async function sendWhatsAppMessage(to, body) {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_WHATSAPP_NUMBER) {
    console.warn('[Reminder] Twilio not configured — skipping WhatsApp reminder');
    return;
  }
  const twilio = require('twilio');
  const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  // Ensure "whatsapp:" prefix
  const toNum = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
  await client.messages.create({
    from: process.env.TWILIO_WHATSAPP_NUMBER,
    to: toNum,
    body: body.slice(0, 1600),
  });
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

function nextReminderDate(intervalDays, reminderTime = '09:00') {
  const [hours, minutes] = (reminderTime || '09:00').split(':').map(Number);
  const date = new Date();
  date.setDate(date.getDate() + intervalDays);
  date.setHours(hours, minutes, 0, 0);
  return date;
}

function formatTime(val) {
  if (!val) return '';
  const [h, m] = val.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  return `${((h % 12) || 12).toString().padStart(2, '0')}:${m.toString().padStart(2, '0')} ${ampm}`;
}

// ─── Email sender ─────────────────────────────────────────────────────────────

async function sendEmailReminder(reminder) {
  const transporter = getTransporter();
  if (!transporter) {
    console.log(`[Reminder] Email not configured — skipping for ${reminder.email}`);
    return;
  }

  const nextDays    = reminder.intervalDays || 1;
  const timeDisplay = formatTime(reminder.reminderTime || '09:00');
  const scheduleLabel = reminder.isOneShot
    ? 'One-time reminder'
    : `Every ${nextDays} day(s) at ${timeDisplay}`;
  const nextLabel = reminder.isOneShot
    ? 'This was a one-time reminder.'
    : `Next reminder: ${nextDays} day(s) from now at ${timeDisplay}`;

  await transporter.sendMail({
    from: `"NoteNexus" <${process.env.EMAIL_USER}>`,
    to: reminder.email,
    subject: `📚 Revision time: ${reminder.topic} (${reminder.subject})`,
    html: `
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
            <p style="margin:0 0 8px"><strong style="color:#60a5fa">Repetition #:</strong> <span style="color:#4ade80">${reminder.repetitions + 1}</span></p>
            <p style="margin:0"><strong style="color:#60a5fa">Schedule:</strong> <span style="color:#f1f5f9">${scheduleLabel}</span></p>
          </div>
          <p style="color:#94a3b8;font-size:13px">${nextLabel}</p>
          <a href="${process.env.FRONTEND_URL || 'https://your-app.vercel.app'}"
             style="display:inline-block;background:#2563eb;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;margin-top:16px">
            Open NoteNexus →
          </a>
        </div>
      </div>
    `,
  });
}

// ─── WhatsApp reminder sender ─────────────────────────────────────────────────

async function sendWhatsAppReminder(reminder) {
  if (!reminder.sendWhatsApp || !reminder.phone) return;

  const timeDisplay  = formatTime(reminder.reminderTime || '09:00');
  const scheduleLabel = reminder.isOneShot
    ? 'One-time reminder'
    : `Every ${reminder.intervalDays} day(s) at ${timeDisplay}`;
  const nextLabel = reminder.isOneShot
    ? 'This was a one-time reminder.'
    : `Next reminder in ${reminder.intervalDays} day(s) at ${timeDisplay}`;

  const msg = [
    `📚 *NoteNexus Revision Reminder*`,
    ``,
    `📖 *Subject:* ${reminder.subject}`,
    `🎯 *Topic:* ${reminder.topic}`,
    `🔁 *Schedule:* ${scheduleLabel}`,
    `✅ *Repetition #${reminder.repetitions + 1}*`,
    ``,
    `${nextLabel}`,
    ``,
    `Open NoteNexus: ${process.env.FRONTEND_URL || 'https://your-app.vercel.app'}`,
  ].join('\n');

  await sendWhatsAppMessage(reminder.phone, msg);
}

// ─── Unified send (email + optional WhatsApp) ─────────────────────────────────

async function sendReminder(reminder) {
  const tasks = [];
  if (reminder.sendEmail !== false) tasks.push(sendEmailReminder(reminder));
  if (reminder.sendWhatsApp && reminder.phone) tasks.push(sendWhatsAppReminder(reminder));
  await Promise.allSettled(tasks);
}

// ─── Cron: runs every minute ──────────────────────────────────────────────────

function startReminderCron() {
  cron.schedule('* * * * *', async () => {
    try {
      const now = new Date();
      const due = await Reminder.find({ active: true, nextReminder: { $lte: now } });

      if (!due.length) return;
      console.log(`[Reminder Cron] Processing ${due.length} due reminder(s)`);

      for (const reminder of due) {
        await sendReminder(reminder);

        if (reminder.isOneShot) {
          // One-shot: deactivate after sending
          reminder.active      = false;
          reminder.lastSentAt  = now;
          reminder.repetitions += 1;
        } else {
          // Repeating: schedule next
          reminder.repetitions  += 1;
          reminder.lastSentAt    = now;
          reminder.nextReminder  = nextReminderDate(reminder.intervalDays, reminder.reminderTime);
        }

        await reminder.save();
        console.log(`[Reminder] Sent "${reminder.topic}" → ${reminder.email}${reminder.sendWhatsApp ? ' + WhatsApp' : ''}`);
      }
    } catch (err) {
      console.error('[Reminder Cron] Error:', err.message);
    }
  });

  console.log('✅ Revision reminder cron started (runs every minute)');
}

module.exports = { startReminderCron, sendEmailReminder, sendWhatsAppReminder, sendReminder };
