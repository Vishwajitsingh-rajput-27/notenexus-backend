const express = require('express');
const router = express.Router();

// ─── WhatsApp Bot via Twilio + Grok AI ────────────────────────────────────
const GROK_API_KEY = process.env.GROK_API_KEY || process.env.XAI_API_KEY;

async function askGrok(prompt) {
  const response = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GROK_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'grok-beta',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 500,
    }),
  });
  const data = await response.json();
  return data.choices[0].message.content;
}

function getTwilioClient() {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    throw new Error('Twilio env vars not set');
  }
  const twilio = require('twilio');
  return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

router.post('/webhook', express.urlencoded({ extended: false }), async (req, res) => {
  try {
    const { Body = '', From } = req.body;
    const text = Body.trim();
    const lower = text.toLowerCase();

    let prompt;
    if (lower.startsWith('summary:')) {
      prompt = `Summarize this in exactly 5 bullet points (use • symbol). Be concise:\n${text.slice(8)}`;
    } else if (lower.startsWith('flashcard:')) {
      prompt = `Generate 5 flashcard Q&A pairs. Format: Q: ... A: ... (each on new line):\n${text.slice(10)}`;
    } else if (lower.startsWith('ask:')) {
      prompt = `You are a helpful study assistant. Answer this question clearly (max 150 words):\n${text.slice(4)}`;
    } else if (lower.startsWith('plan:')) {
      prompt = `Create a simple 3-day study plan for: ${text.slice(5)}. Keep it short and actionable.`;
    } else {
      prompt = `You are NoteNexus AI study assistant. Help this student (max 200 words):\n${text}\n\nTip: Send 'summary: <text>', 'flashcard: <text>', 'ask: <question>' or 'plan: <subjects>' for specific help.`;
    }

    const reply = (await askGrok(prompt)).slice(0, 1500);

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

router.get('/status', (req, res) => {
  res.json({
    configured: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && GROK_API_KEY),
    webhookUrl: `https://notenexus-backend-y20v.onrender.com/api/whatsapp/webhook`,
  });
});

module.exports = router;
