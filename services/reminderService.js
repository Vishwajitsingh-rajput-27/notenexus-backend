const cron = require('node-cron');
const nodemailer = require('nodemailer');
const Reminder = require('../models/Reminder');

// ─── Revision Reminder Service ─────────────────────────────────────────────
// REQUIRES env vars in your Render dashboard:
//   EMAIL_USER=your-gmail@gmail.com
//   EMAIL_PASS=your-gmail-app-password   ← Google App Password, NOT login password
//   FRONTEND_URL=https://your-app.vercel.app
//
//   How to get App Password:
//   myaccount.google.com → Security → 2-Step Verification → App Passwords
// ──────────────────────────────────────────────────────────────────────────

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

// Build next reminder date: intervalDays from now at the user's chosen HH:MM
function nextReminderDate(intervalDays, reminderTime = '09:00') {
  const [hours, minutes] = (reminderTime || '09:00').split(':').map(Number);
  const date = new Date();
  date.setDate(date.getDate() + intervalDays);
  date.setHours(hours, minutes, 0, 0);
  return date;
}

async function sendEmailReminder(reminder) {
  const transporter = getTransporter();
  if (!transporter) {
    console.log(`[Reminder] Email not configured — skipping for ${reminder.email}`);
    return;
  }

  const nextDays = reminder.intervalDays || 1;
  const timeLabel = reminder.reminderTime || '09:00';
  const [h, m] = timeLabel.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const timeDisplay = `${((h % 12) || 12).toString().padStart(2,'0')}:${m.toString().padStart(2,'0')} ${ampm}`;

  await transporter.sendMail({
    from: `"NoteNexus" <${process.env.EMAIL_USER}>`,
    to: reminder.email,
    subject: `📚 Revision time: ${reminder.topic} (${reminder.subject})`,
    html: `
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto;background:#0f172a;color:#e2e8f0;border-radius:12px;overflow:hidden">
        <div style="background:linear-gradient(135deg,#1e40af,#7c3aed);padding:28px 32px">
          <h1 style="margin:0;font-size:24px;color:#fff">📚 NoteNexus</h1>
          <p style="margin:6px 0 0;color:#bfdbfe;font-size:14px">Spaced Repetition Reminder</p>
        </div>
        <div style="padding:32px">
          <h2 style="margin:0 0 8px;color:#f8fafc">Time to revise!</h2>
          <p style="color:#94a3b8;margin:0 0 24px">Based on your spaced repetition schedule:</p>
          <div style="background:#1e293b;border-radius:8px;padding:20px;margin-bottom:24px">
            <p style="margin:0 0 8px"><strong style="color:#60a5fa">Subject:</strong> <span style="color:#f1f5f9">${reminder.subject}</span></p>
            <p style="margin:0 0 8px"><strong style="color:#60a5fa">Topic:</strong> <span style="color:#f1f5f9">${reminder.topic}</span></p>
            <p style="margin:0 0 8px"><strong style="color:#60a5fa">Repetition #:</strong> <span style="color:#4ade80">${reminder.repetitions + 1}</span></p>
            <p style="margin:0"><strong style="color:#60a5fa">Schedule:</strong> <span style="color:#f1f5f9">Every ${nextDays} day(s) at ${timeDisplay}</span></p>
          </div>
          <p style="color:#94a3b8;font-size:13px">Next reminder: <strong style="color:#f8fafc">${nextDays} day(s) from now at ${timeDisplay}</strong></p>
          <a href="${process.env.FRONTEND_URL || 'https://your-app.vercel.app'}"
             style="display:inline-block;background:#2563eb;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;margin-top:16px">
            Open NoteNexus →
          </a>
        </div>
      </div>
    `,
  });
}

function startReminderCron() {
  // Run every minute — check if any reminder is due (matches current HH:MM and date)
  cron.schedule('* * * * *', async () => {
    try {
      const now = new Date();
      // Find reminders whose nextReminder timestamp is in the past or now
      const due = await Reminder.find({ active: true, nextReminder: { $lte: now } });

      if (due.length === 0) return;
      console.log(`[Reminder Cron] Processing ${due.length} due reminder(s)`);

      for (const reminder of due) {
        await sendEmailReminder(reminder);

        const nextDays = reminder.intervalDays || 1;
        const reminderTime = reminder.reminderTime || '09:00';

        reminder.repetitions  += 1;
        reminder.lastSentAt    = now;
        reminder.nextReminder  = nextReminderDate(nextDays, reminderTime);
        await reminder.save();

        console.log(`[Reminder] Sent to ${reminder.email} for "${reminder.topic}" — next in ${nextDays}d at ${reminderTime}`);
      }
    } catch (err) {
      console.error('[Reminder Cron] Error:', err.message);
    }
  });

  console.log('✅ Revision reminder cron started (runs every minute, respects user-set times)');
}

module.exports = { startReminderCron, sendEmailReminder };
