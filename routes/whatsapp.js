const express = require('express');
const router = express.Router();
const https = require('https');

// ─── WhatsApp Bot via Twilio + Groq AI ────────────────────────────────────

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
          if (parsed.error) {
            console.error('Groq error:', parsed.error);
            return reject(new Error(parsed.error.message));
          }
          if (!parsed.choices?.[0]?.message?.content) {
            console.error('Groq bad response:', JSON.stringify(parsed));
            return reject(new Error('Empty response from Groq'));
          }
          resolve(parsed.choices[0].message.content);
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(25000, () => {
      req.destroy();
      reject(new Error('Groq timeout'));
    });
    req.write(body);
    req.end();
  });
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

    if (!text) {
      return res.sendStatus(200);
    }

    let prompt;
    if (lower.startsWith('summary:')) {
      prompt = `Summarize this in exactly 5 bullet points (use • symbol). Be concise:\n${text.slice(8)}`;
    } else if (lower.startsWith('flashcard:')) {
      prompt = `Generate 5 flashcard Q&A pairs. Format:\nQ: ...\nA: ...\n(each pair on new lines)\n\nContent:\n${text.slice(10)}`;
    } else if (lower.startsWith('ask:')) {
      prompt = `You are a helpful study assistant. Answer this question clearly and concisely in max 150 words:\n${text.slice(4)}`;
    } else if (lower.startsWith('plan:')) {
      prompt = `Create a simple 3-day study plan for: ${text.slice(5)}. Keep it short and actionable with specific time slots.`;
    } else {
      prompt = `You are NoteNexus AI, a study assistant on WhatsApp. Help this student with their query in max 200 words:\n\n"${text}"\n\nAt the end, remind them they can use:\n• summary: <text>\n• flashcard: <text>\n• ask: <question>\n• plan: <subjects>`;
    }

    console.log(`WhatsApp message from ${From}: ${text.slice(0, 50)}`);

    const reply = (await askGroq(prompt)).slice(0, 1500);

    const client = getTwilioClient();
    await client.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: From,
      body: `🤖 NoteNexus AI\n\n${reply}`,
    });

    console.log(`WhatsApp reply sent to ${From}`);
    res.sendStatus(200);

  } catch (err) {
    console.error('WhatsApp webhook error:', err.message);
    res.sendStatus(500);
  }
});

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
