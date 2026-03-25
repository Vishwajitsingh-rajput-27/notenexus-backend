const express  = require('express');
const router   = express.Router();
const https    = require('https');
const crypto   = require('crypto');
const auth     = require('../middleware/auth');
const { WhatsAppSession, WhatsAppLinkCode } = require('../models/WhatsAppSession');
const Note      = require('../models/Note');
const SavedItem = require('../models/SavedItem');
const Reminder  = require('../models/Reminder');

// ─── Groq AI helper ───────────────────────────────────────────────────────────

async function askGroq(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 500,
      temperature: 0.7,
    });

    const options = {
      hostname: 'api.groq.com',
      path: '/openai/v1/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message));
          if (!parsed.choices?.[0]?.message?.content) return reject(new Error('Empty response from Groq'));
          resolve(parsed.choices[0].message.content);
        } catch (e) { reject(e); }
      });
    });

    req.on('error', reject);
    req.setTimeout(25000, () => { req.destroy(); reject(new Error('Groq timeout')); });
    req.write(body);
    req.end();
  });
}

// ─── Twilio helper ────────────────────────────────────────────────────────────

function getTwilioClient() {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    throw new Error('Twilio env vars not set');
  }
  const twilio = require('twilio');
  return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

async function sendWhatsApp(to, body) {
  const client = getTwilioClient();
  await client.messages.create({
    from: process.env.TWILIO_WHATSAPP_NUMBER,
    to,
    body: body.slice(0, 1600),
  });
}

// ─── Format helpers ───────────────────────────────────────────────────────────

function formatNotesList(notes) {
  if (!notes.length) return '📭 You have no notes yet.\n\nUpload notes at notenexus.vercel.app';
  const lines = notes.slice(0, 10).map((n, i) => {
    const date = new Date(n.createdAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
    return `${i + 1}. 📄 *${n.title}*\n   Subject: ${n.subject} | ${n.chapter}\n   Added: ${date}`;
  });
  const extra = notes.length > 10 ? `\n\n...and ${notes.length - 10} more notes.` : '';
  return `📚 *Your Notes* (${notes.length} total)\n\n${lines.join('\n\n')}${extra}\n\nType a number (e.g. *1*) to read that note.`;
}

function formatSavedList(items) {
  if (!items.length) return '📭 You have no saved items yet.\n\nSave flashcards, mind maps & more from notenexus.vercel.app';
  const emoji = { mindmap: '🗺️', flashcards: '🃏', chat: '💬', studyplan: '📅', examquestions: '📝', quiz: '❓' };
  const lines = items.slice(0, 10).map((item, i) => {
    const date = new Date(item.createdAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
    const icon = emoji[item.type] || '📌';
    return `${i + 1}. ${icon} *${item.name}*\n   Type: ${item.type}${item.subject ? ' | ' + item.subject : ''}\n   Saved: ${date}`;
  });
  const extra = items.length > 10 ? `\n\n...and ${items.length - 10} more items.` : '';
  return `💾 *Your Saved Items* (${items.length} total)\n\n${lines.join('\n\n')}${extra}\n\nType a number (e.g. *1*) to view that item.`;
}

function formatNoteDetail(note) {
  const preview = note.content ? note.content.slice(0, 600) : '(no content extracted)';
  return `📄 *${note.title}*\nSubject: ${note.subject} | ${note.chapter}\nKeywords: ${(note.keywords || []).join(', ') || 'none'}\n\n${preview}${note.content?.length > 600 ? '...' : ''}`;
}

function formatSavedDetail(item) {
  const emoji = { mindmap: '🗺️', flashcards: '🃏', chat: '💬', studyplan: '📅', examquestions: '📝', quiz: '❓' };
  const icon  = emoji[item.type] || '📌';
  let content = '';

  if (item.type === 'flashcards' && Array.isArray(item.data)) {
    content = item.data.slice(0, 5).map((f, i) => `Q${i+1}: ${f.question}\nA${i+1}: ${f.answer}`).join('\n\n');
    if (item.data.length > 5) content += `\n\n...and ${item.data.length - 5} more cards.`;
  } else if (item.type === 'studyplan' && item.data?.plan) {
    content = typeof item.data.plan === 'string' ? item.data.plan.slice(0, 600) : JSON.stringify(item.data.plan).slice(0, 600);
  } else if (item.type === 'examquestions' && Array.isArray(item.data)) {
    content = item.data.slice(0, 5).map((q, i) => `Q${i+1}: ${typeof q === 'string' ? q : q.question || JSON.stringify(q)}`).join('\n\n');
  } else if (item.type === 'mindmap') {
    content = item.data?.summary || item.data?.title || 'Mind map saved — view it on the app.';
  } else {
    const raw = JSON.stringify(item.data);
    content = raw.slice(0, 600) + (raw.length > 600 ? '...' : '');
  }

  return `${icon} *${item.name}* [${item.type}]\n${item.subject ? 'Subject: ' + item.subject + '\n' : ''}\n${content}`;
}

// ─── Numbered item selection (in-memory cache) ────────────────────────────────
const listCache = new Map(); // phone -> { type: 'notes'|'saved', items: [...] }

// ─── POST /api/whatsapp/webhook ───────────────────────────────────────────────

router.post('/webhook', express.urlencoded({ extended: false }), async (req, res) => {
  try {
    const { Body = '', From } = req.body;
    const text  = Body.trim();
    const lower = text.toLowerCase();

    if (!text) return res.sendStatus(200);

    console.log(`WhatsApp from ${From}: ${text.slice(0, 80)}`);

    // ── Link command (no auth needed) ─────────────────────────────────────────
    if (lower.startsWith('link ')) {
      const code = text.slice(5).trim().toUpperCase();
      const linkEntry = await WhatsAppLinkCode.findOne({ code });
      if (!linkEntry) {
        await sendWhatsApp(From, '❌ Invalid or expired link code.\n\nGenerate a new one from the NoteNexus app (WhatsApp tab).');
        return res.sendStatus(200);
      }
      await WhatsAppSession.findOneAndUpdate(
        { phone: From },
        { phone: From, userId: linkEntry.userId, linkedAt: new Date() },
        { upsert: true, new: true }
      );
      await WhatsAppLinkCode.deleteOne({ code });
      await sendWhatsApp(From, '✅ *NoteNexus linked successfully!*\n\nYou can now access your notes and saved items.\n\nTry:\n• *notes* — list your notes\n• *saved* — list saved items\n• *notes: <subject>* — filter by subject\n• *saved: flashcards* — filter by type');
      return res.sendStatus(200);
    }

    // ── Find linked user ───────────────────────────────────────────────────────
    const session = await WhatsAppSession.findOne({ phone: From });
    const userId  = session?.userId;

    // ── Notes commands ────────────────────────────────────────────────────────
    if (lower === 'notes' || lower.startsWith('notes:')) {
      if (!userId) {
        await sendWhatsApp(From, '🔒 Link your NoteNexus account first:\n\n1. Open the NoteNexus app\n2. Go to *WhatsApp* tab\n3. Click *Generate Link Code*\n4. Send: *link <code>* here');
        return res.sendStatus(200);
      }
      const subject = lower.startsWith('notes:') ? text.slice(6).trim() : null;
      const filter  = { userId };
      if (subject) filter.subject = new RegExp(subject, 'i');
      const notes = await Note.find(filter).sort({ createdAt: -1 }).limit(20).select('-content');
      listCache.set(From, { type: 'notes', items: notes });
      await sendWhatsApp(From, formatNotesList(notes));
      return res.sendStatus(200);
    }

    // ── Saved items commands ──────────────────────────────────────────────────
    if (lower === 'saved' || lower.startsWith('saved:')) {
      if (!userId) {
        await sendWhatsApp(From, '🔒 Link your NoteNexus account first:\n\n1. Open the NoteNexus app\n2. Go to *WhatsApp* tab\n3. Click *Generate Link Code*\n4. Send: *link <code>* here');
        return res.sendStatus(200);
      }
      const typeFilter = lower.startsWith('saved:') ? text.slice(6).trim().toLowerCase() : null;
      const filter = { userId };
      const validTypes = ['mindmap', 'flashcards', 'chat', 'studyplan', 'examquestions', 'quiz'];
      if (typeFilter && validTypes.includes(typeFilter)) filter.type = typeFilter;
      const items = await SavedItem.find(filter).sort({ createdAt: -1 }).limit(20);
      listCache.set(From, { type: 'saved', items });
      await sendWhatsApp(From, formatSavedList(items));
      return res.sendStatus(200);
    }

    // ── Numbered selection from previous list ────────────────────────────────
    const num = parseInt(text, 10);
    if (!isNaN(num) && num > 0 && listCache.has(From)) {
      const cached = listCache.get(From);
      const item   = cached.items[num - 1];
      if (item) {
        if (cached.type === 'notes') {
          const full = await Note.findById(item._id);
          await sendWhatsApp(From, full ? formatNoteDetail(full) : '❌ Could not load note.');
        } else {
          await sendWhatsApp(From, formatSavedDetail(item));
        }
        return res.sendStatus(200);
      }
    }

    // ── Reminder commands ────────────────────────────────────────────────────
    // remind me: <topic> | <subject> | today 15:30
    // remind me: <topic> | <subject> | every 3 days 09:00
    // remind me: <topic> | <subject> | every 45 minutes
    // remind me: <topic> | <subject> | on 2026-04-10 08:00
    // reminders — list active reminders
    // cancel reminder <number>

    if (lower === 'reminders' || lower === 'my reminders') {
      if (!userId) {
        await sendWhatsApp(From, '🔒 Link your NoteNexus account to manage reminders.\n\nSend: *link <code>* (get the code from the app).');
        return res.sendStatus(200);
      }
      const rems = await Reminder.find({ user: userId, active: true }).sort('-createdAt').limit(10);
      if (!rems.length) {
        await sendWhatsApp(From, '📭 You have no active reminders.\n\nCreate one:\n*remind me: Calculus | Maths | every 3 days 09:00*');
        return res.sendStatus(200);
      }
      listCache.set(From + ':reminders', rems);
      const lines = rems.map((r, i) => {
        const schedule = r.isOneShot
          ? `once on ${new Date(r.oneShotAt || r.nextReminder).toLocaleDateString('en-GB', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' })}`
          : `every ${r.intervalDays} day(s) at ${r.reminderTime}`;
        return `${i + 1}. 🔔 *${r.topic}* (${r.subject})\n   ${schedule}${r.sendWhatsApp ? ' 📱' : ' 📧'}`;
      });
      await sendWhatsApp(From, `🔔 *Your Active Reminders* (${rems.length})\n\n${lines.join('\n\n')}\n\nSend *cancel reminder <number>* to delete one.`);
      return res.sendStatus(200);
    }

    if (lower.startsWith('cancel reminder ')) {
      if (!userId) {
        await sendWhatsApp(From, '🔒 Link your account first.');
        return res.sendStatus(200);
      }
      const n = parseInt(text.slice(16).trim(), 10);
      const cached = listCache.get(From + ':reminders');
      if (isNaN(n) || !cached || !cached[n - 1]) {
        await sendWhatsApp(From, '❌ Send *reminders* first, then *cancel reminder <number>*.');
        return res.sendStatus(200);
      }
      const rem = cached[n - 1];
      await Reminder.findOneAndUpdate({ _id: rem._id, user: userId }, { active: false });
      listCache.delete(From + ':reminders');
      await sendWhatsApp(From, `✅ Reminder "${rem.topic}" cancelled.`);
      return res.sendStatus(200);
    }

    // remind me: <topic> | <subject> | <schedule>
    if (lower.startsWith('remind me:') || lower.startsWith('remind:')) {
      if (!userId) {
        await sendWhatsApp(From, '🔒 Link your NoteNexus account first to set reminders.\n\nSend: *link <code>* (get the code from the app).');
        return res.sendStatus(200);
      }

      const raw = text.slice(lower.startsWith('remind me:') ? 10 : 7).trim();
      // Format: <topic> | <subject> | <schedule>
      const parts = raw.split('|').map(s => s.trim());
      if (parts.length < 2) {
        await sendWhatsApp(From,
          '❌ Format:\n*remind me: <topic> | <subject> | <schedule>*\n\nExamples:\n' +
          '• remind me: Calculus | Maths | today 18:00\n' +
          '• remind me: Cell biology | Biology | every 3 days 09:00\n' +
          '• remind me: Vocab | English | every 30 minutes\n' +
          '• remind me: Past papers | Physics | on 2026-04-15 10:00'
        );
        return res.sendStatus(200);
      }

      const topic   = parts[0];
      const subject = parts[1];
      const sched   = (parts[2] || 'every 1 day 09:00').toLowerCase();

      // Get user email from DB
      const User = require('../models/User');
      const userDoc = await User.findById(userId).select('email');
      const email = userDoc?.email || '';

      // Get linked WhatsApp phone
      const sess = await WhatsAppSession.findOne({ userId });

      // Parse schedule string
      let scheduleType    = 'repeating';
      let intervalDays    = 1;
      let intervalMinutes = null;
      let reminderTime    = '09:00';
      let customDate      = null;

      // Extract time (HH:MM) from anywhere in the schedule string
      const timeMatch = sched.match(/\b(\d{1,2}):(\d{2})\b/);
      if (timeMatch) {
        reminderTime = `${timeMatch[1].padStart(2,'0')}:${timeMatch[2]}`;
      }

      if (sched.startsWith('today')) {
        scheduleType = 'today';

      } else if (sched.match(/on\s+\d{4}-\d{2}-\d{2}/)) {
        scheduleType = 'custom_date';
        const dateMatch = sched.match(/(\d{4}-\d{2}-\d{2})/);
        customDate = dateMatch ? dateMatch[1] : null;

      } else if (sched.includes('minute')) {
        scheduleType = 'interval_minutes';
        const minsMatch = sched.match(/(\d+)\s*min/);
        intervalMinutes = minsMatch ? parseInt(minsMatch[1]) : 30;

      } else {
        // every N days
        scheduleType = 'repeating';
        const daysMatch = sched.match(/(\d+)\s*day/);
        intervalDays = daysMatch ? parseInt(daysMatch[1]) : 1;
      }

      try {
        const { sendReminder } = require('../services/reminderService');

        // Build nextReminder
        let nextReminder;
        let isOneShot = false;
        let oneShotAt = null;
        const [h, m]  = reminderTime.split(':').map(Number);

        if (scheduleType === 'today') {
          isOneShot = true;
          oneShotAt = new Date();
          oneShotAt.setHours(h, m, 0, 0);
          if (oneShotAt <= new Date()) oneShotAt.setDate(oneShotAt.getDate() + 1);
          nextReminder = oneShotAt;
        } else if (scheduleType === 'custom_date') {
          isOneShot = true;
          oneShotAt = new Date(`${customDate}T${reminderTime}:00`);
          nextReminder = oneShotAt;
        } else if (scheduleType === 'interval_minutes') {
          nextReminder = new Date(Date.now() + intervalMinutes * 60 * 1000);
          intervalDays = 0;
        } else {
          nextReminder = new Date(); // send immediately then schedule
        }

        const reminder = await Reminder.create({
          user: userId, subject, topic, email,
          phone: sess?.phone || '',
          intervalDays,
          reminderTime,
          isOneShot, oneShotAt, nextReminder,
          sendEmail: true,
          sendWhatsApp: true, // always send to WhatsApp since they set it from WhatsApp
        });

        // Send first one now for repeating
        if (!isOneShot) {
          await sendReminder(reminder);
          reminder.lastSentAt  = new Date();
          reminder.repetitions = 1;
          if (intervalMinutes) {
            reminder.nextReminder = new Date(Date.now() + intervalMinutes * 60 * 1000);
          } else {
            const next = new Date();
            next.setDate(next.getDate() + intervalDays);
            next.setHours(h, m, 0, 0);
            reminder.nextReminder = next;
          }
          await reminder.save();
        }

        const schedLabel = scheduleType === 'today'
          ? `Today at ${reminderTime}`
          : scheduleType === 'custom_date'
          ? `${customDate} at ${reminderTime}`
          : scheduleType === 'interval_minutes'
          ? `Every ${intervalMinutes} minutes`
          : `Every ${intervalDays} day(s) at ${reminderTime}`;

        await sendWhatsApp(From,
          `✅ *Reminder set!*\n\n` +
          `📖 *Topic:* ${topic}\n` +
          `📚 *Subject:* ${subject}\n` +
          `🕐 *Schedule:* ${schedLabel}\n` +
          `📱 *Via:* WhatsApp + Email\n\n` +
          `Send *reminders* to see all your reminders.`
        );
      } catch (err) {
        console.error('[WhatsApp] reminder creation error:', err.message);
        await sendWhatsApp(From, `❌ Could not create reminder: ${err.message}`);
      }
      return res.sendStatus(200);
    }

    // ── AI study commands ─────────────────────────────────────────────────────
    let prompt;
    if (lower.startsWith('summary:')) {
      prompt = `Summarize this in exactly 5 bullet points (use • symbol). Be concise:\n${text.slice(8)}`;
    } else if (lower.startsWith('flashcard:')) {
      prompt = `Generate 5 flashcard Q&A pairs. Format:\nQ: ...\nA: ...\n(each pair on new lines)\n\nContent:\n${text.slice(10)}`;
    } else if (lower.startsWith('ask:')) {
      prompt = `You are a helpful study assistant. Answer clearly and concisely in max 150 words:\n${text.slice(4)}`;
    } else if (lower.startsWith('plan:')) {
      prompt = `Create a simple 3-day study plan for: ${text.slice(5)}. Keep it short and actionable with specific time slots.`;
    } else {
      const linkedHint = userId
        ? '• notes — your notes list\n• saved — your saved items\n• remind me: <topic> | <subject> | today 18:00\n• remind me: <topic> | <subject> | every 3 days 09:00\n• reminders — list all reminders'
        : '• Link your account (WhatsApp tab in app) to access notes, saved items & reminders.';
      prompt = `You are NoteNexus AI, a study assistant on WhatsApp. Help this student with their query in max 200 words:\n\n"${text}"\n\nAt the end, remind them they can use:\n• summary: <text>\n• flashcard: <text>\n• ask: <question>\n• plan: <subjects>\n${linkedHint}`;
    }

    const reply = (await askGroq(prompt)).slice(0, 1500);
    await sendWhatsApp(From, `🤖 NoteNexus AI\n\n${reply}`);
    res.sendStatus(200);

  } catch (err) {
    console.error('WhatsApp webhook error:', err.message);
    res.sendStatus(500);
  }
});

// ─── POST /api/whatsapp/generate-link-code  (authenticated) ──────────────────

router.post('/generate-link-code', auth, async (req, res) => {
  try {
    await WhatsAppLinkCode.deleteMany({ userId: req.user._id });
    const code = crypto.randomBytes(3).toString('hex').toUpperCase();
    await WhatsAppLinkCode.create({ code, userId: req.user._id });
    res.json({ code, expiresIn: 600 });
  } catch (err) {
    console.error('[whatsapp] generate-link-code error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/whatsapp/unlink  (authenticated) ────────────────────────────

router.delete('/unlink', auth, async (req, res) => {
  try {
    const result = await WhatsAppSession.findOneAndDelete({ userId: req.user._id });
    res.json({ unlinked: !!result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/whatsapp/link-status  (authenticated) ──────────────────────────

router.get('/link-status', auth, async (req, res) => {
  try {
    const session = await WhatsAppSession.findOne({ userId: req.user._id });
    res.json({
      linked: !!session,
      phone: session?.phone ? session.phone.replace('whatsapp:', '') : null,
      linkedAt: session?.linkedAt || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/whatsapp/status ─────────────────────────────────────────────────

router.get('/status', (req, res) => {
  res.json({
    configured: !!(
      process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_AUTH_TOKEN &&
      process.env.GROQ_API_KEY
    ),
    webhookUrl: `https://notenexus-backend-y20v.onrender.com/api/whatsapp/webhook`,
    aiModel: 'llama-3.3-70b-versatile (Groq)',
  });
});

module.exports = router;
// NOTE: The reminder commands are embedded in the main webhook handler above.
// This file is complete as-is.
