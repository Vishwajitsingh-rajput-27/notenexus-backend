const express = require('express');
const router = express.Router();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const auth = require('../middleware/auth');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ─── AI Tutor ──────────────────────────────────────────────────────────────
// POST /api/tutor/chat   → send a message, get tutor reply
// POST /api/tutor/quiz   → generate a quick quiz on the current topic
// ──────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = (subject, level) => `You are an expert ${subject} tutor teaching a ${level}-level student.

Your teaching rules:
1. Explain concepts clearly using real-world examples and analogies
2. After each explanation, ask ONE comprehension check question to test understanding
3. If the student answers incorrectly, say "Not quite — " then gently re-explain with a different example
4. If the student answers correctly, say "Excellent! " and give brief praise before moving on
5. Break complex topics into small digestible steps — never overwhelm
6. Keep responses under 200 words unless the student explicitly asks for more
7. Use simple language for beginners, technical depth for advanced students
8. If the student seems confused, try a completely different analogy
9. Occasionally suggest: "Try this yourself: [simple exercise]"
10. Be warm, encouraging, and patient at all times`;

async function chatWithGemini(subject, level, history, message) {
  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

  const chatHistory = [
    { role: 'user', parts: [{ text: SYSTEM_PROMPT(subject, level) }] },
    { role: 'model', parts: [{ text: `I'm your ${subject} tutor! I'll explain clearly, check your understanding, and guide you step by step. What topic would you like to start with?` }] },
    ...history.map(h => ({
      role: h.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: h.content }],
    })),
  ];

  const chat = model.startChat({ history: chatHistory });
  const result = await chat.sendMessage(message);
  return result.response.text();
}

async function chatWithGrok(subject, level, history, message) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT(subject, level) },
    ...history.map(h => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.content })),
    { role: 'user', content: message },
  ];

  const response = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.GROK_API_KEY || process.env.XAI_API_KEY}`,
    },
    body: JSON.stringify({ model: 'grok-beta', messages, max_tokens: 500 }),
  });
  const data = await response.json();
  return data.choices[0].message.content;
}

// POST /api/tutor/chat
router.post('/chat', auth, async (req, res) => {
  try {
    const {
      message,
      history = [],
      subject = 'General',
      level = 'beginner',
      aiModel = 'gemini',
    } = req.body;

    if (!message?.trim()) return res.status(400).json({ error: 'Message is required' });

    // Trim history to last 20 messages to avoid token overflow
    const trimmedHistory = history.slice(-20);

    let reply;
    let usedModel = aiModel;

    try {
      if (aiModel === 'grok' && (process.env.GROK_API_KEY || process.env.XAI_API_KEY)) {
        reply = await chatWithGrok(subject, level, trimmedHistory, message);
      } else {
        reply = await chatWithGemini(subject, level, trimmedHistory, message);
        usedModel = 'gemini';
      }
    } catch (err) {
      console.warn(`Tutor ${aiModel} failed, falling back:`, err.message);
      reply = usedModel === 'gemini'
        ? await chatWithGrok(subject, level, trimmedHistory, message)
        : await chatWithGemini(subject, level, trimmedHistory, message);
      usedModel += '-fallback';
    }

    res.json({ success: true, reply, usedModel });
  } catch (err) {
    console.error('AI Tutor error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/tutor/quiz — generate a 5-question quiz on a topic
router.post('/quiz', auth, async (req, res) => {
  try {
    const { subject, topic, level = 'beginner' } = req.body;
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

    const prompt = `Generate a 5-question ${level}-level quiz on "${topic}" in ${subject}.
Return ONLY valid JSON array:
[{"q":"question","options":["A)..","B)..","C)..","D).."],"answer":"A","explanation":"..."}]`;

    const result = await model.generateContent(prompt);
    const text = result.response.text().replace(/```json\n?|```\n?/g, '').trim();
    const quiz = JSON.parse(text.match(/\[[\s\S]*\]/)[0]);

    res.json({ success: true, quiz, topic, subject, level });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
