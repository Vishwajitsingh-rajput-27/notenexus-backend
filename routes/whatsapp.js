const express = require('express');
const router = express.Router();

// ─── WhatsApp Bot via Twilio ───────────────────────────────────────────────
// REQUIRES: npm install twilio  (add to package.json)
// REQUIRES env vars on Render:
//   TWILIO_ACCOUNT_SID=ACxxxxxxxx
//   TWILIO_AUTH_TOKEN=xxxxxxxx
//   TWILIO_WHATSAPP_NUMBER=whatsapp:+14155238886
//
// Setup: https://console.twilio.com → Messaging → WhatsApp Sandbox
// Webhook URL: https://notenexus-backend.onrender.com/api/whatsapp/webhook
// ──────────────────────────────────────────────────────────────────────────

const { GoogleGenerativeAI } = require('@google/generative-ai');
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Lazy-init Twilio so app still boots without Twilio keys
function getTwilioClient() {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    throw new Error('Twilio env vars not set');
  }
  const twilio = require('twilio');
  return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

// Commands students can send:
//   summary: <text>      → 5-bullet summary
//   flashcard: <text>    → 5 Q&A pairs
//   ask: <question>      → direct answer
//   plan: <subjects>     → quick 3-day plan
//   anything else        → general study help

router.post('/webhook', express.urlencoded({ extended: false }), async (req, res) => {
  try {
    const { Body = '', From } = req.body;
    const text = Body.trim();
    const lower = text.toLowerCase();

    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

    let prompt;
    if (lower.startsWith('summary:')) {
      prompt = `Summarize this in exactly 5 bullet points (use • symbol). Be concise:\n${text.slice(8)}`;
    } else if (lower.startsWith('flashcard:')) {
      prompt = `Generate 5 flashcard Q&A pairs from this content. Format: Q: ... A: ... (each on new line):\n${text.slice(10)}`;
    } else if (lower.startsWith('ask:')) {
      prompt = `You are a helpful study assistant. Answer this student question clearly and concisely (max 150 words):\n${text.slice(4)}`;
    } else if (lower.startsWith('plan:')) {
      prompt = `Create a simple 3-day study plan for: ${text.slice(5)}. Keep it short and actionable.`;
    } else {
      prompt = `You are NoteNexus AI study assistant. Help this student (max 200 words):\n${text}\n\nTip: Send 'summary: <text>', 'flashcard: <text>', or 'ask: <question>' for specific help.`;
    }

    const result = await model.generateContent(prompt);
    const reply = result.response.text().slice(0, 1500); // Twilio limit

    const client = getTwilioClient();
    await client.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: From,
      body: `🤖 NoteNexus AI\n\n${reply}`,
    });

    res.sendStatus(200);
  } catch (err) {
    console.error('WhatsApp webhook error:', err.message);
    res.sendStatus(500);
  }
});

// Status endpoint — check if WhatsApp is configured
router.get('/status', (req, res) => {
  res.json({
    configured: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN),
    webhookUrl: `${process.env.FRONTEND_URL?.replace('frontend', 'backend') || 'https://your-render-url.onrender.com'}/api/whatsapp/webhook`,
  });
});

module.exports = router;
