const cron = require('node-cron');
const nodemailer = require('nodemailer');
const Reminder = require('../models/Reminder');
const { INTERVALS } = require('../models/Reminder');

// ─── Revision Reminder Service ─────────────────────────────────────────────
// REQUIRES: npm install node-cron nodemailer
// OPTIONAL env vars (skip to disable email):
//   EMAIL_USER=your-gmail@gmail.com
//   EMAIL_PASS=your-gmail-app-password   ← Google App Password, not login password
//   Get App Password: myaccount.google.com → Security → App Passwords
// ──────────────────────────────────────────────────────────────────────────

function getTransporter() {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) return null;
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
  });
}

async function sendEmailReminder(reminder) {
  const transporter = getTransporter();
  if (!transporter) {
    console.log(`[Reminder] Email not configured — skipping email for ${reminder.email}`);
    return;
  }

  const nextIdx = Math.min(reminder.repetitions + 1, INTERVALS.length - 1);
  const nextDays = INTERVALS[nextIdx];

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
            <p style="margin:0"><strong style="color:#60a5fa">Repetition #:</strong> <span style="color:#4ade80">${reminder.repetitions + 1}</span></p>
          </div>
          <p style="color:#94a3b8;font-size:13px">Next reminder in <strong style="color:#f8fafc">${nextDays} day(s)</strong></p>
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
  // Run every hour on the hour
  cron.schedule('0 * * * *', async () => {
    try {
      const now = new Date();
      const due = await Reminder.find({ active: true, nextReminder: { $lte: now } });

      if (due.length === 0) return;
      console.log(`[Reminder Cron] Processing ${due.length} due reminder(s)`);

      for (const reminder of due) {
        await sendEmailReminder(reminder);

        // Advance spaced repetition
        const nextIdx = Math.min(reminder.repetitions, INTERVALS.length - 1);
        const nextDays = INTERVALS[nextIdx];

        reminder.repetitions += 1;
        reminder.lastSentAt = now;
        reminder.nextReminder = new Date(Date.now() + nextDays * 86400000);
        await reminder.save();

        console.log(`[Reminder] Sent to ${reminder.email} for "${reminder.topic}" — next in ${nextDays}d`);
      }
    } catch (err) {
      console.error('[Reminder Cron] Error:', err.message);
    }
  });

  console.log('✅ Revision reminder cron started (runs hourly)');
}

module.exports = { startReminderCron };
