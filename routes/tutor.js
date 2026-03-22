const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const https = require('https');

// ─── Groq call ────────────────────────────────────────────────────────────────
const groqCall = (messages, maxTokens = 1024) => new Promise((resolve, reject) => {
  const body = JSON.stringify({
    model: 'llama-3.3-70b-versatile',
    messages,
    max_tokens: maxTokens,
    temperature: 0.5,
  });
  const options = {
    hostname: 'api.groq.com',
    path: '/openai/v1/chat/completions',
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  };
  const req = https.request(options, (res) => {
    let data = '';
    res.on('data', c => data += c);
    res.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        if (parsed.error) return reject(new Error(parsed.error.message));
        resolve(parsed.choices?.[0]?.message?.content || '');
      } catch (e) { reject(e); }
    });
  });
  req.on('error', reject);
  req.setTimeout(30000, () => { req.destroy(); reject(new Error('Groq timeout')); });
  req.write(body);
  req.end();
});

const SYSTEM_PROMPT = (subject, level) =>
  `You are an expert ${subject} tutor teaching a ${level}-level student.
Teaching rules:
1. Explain concepts clearly using real-world examples and analogies
2. After each explanation, ask ONE comprehension check question
3. If the student answers incorrectly, say "Not quite — " then re-explain with a different example
4. If correct, say "Excellent! " and give brief praise before moving on
5. Break complex topics into small digestible steps — never overwhelm
6. Keep responses under 200 words unless the student explicitly asks for more
7. Use simple language for beginners, technical depth for advanced students
8. If confused, try a completely different analogy
9. Occasionally suggest: "Try this yourself: [simple exercise]"
10. Be warm, encouraging, and patient at all times`;

// POST /api/tutor/chat
router.post('/chat', auth, async (req, res) => {
  try {
    const { message, history = [], subject = 'General', level = 'beginner' } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'Message is required' });

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT(subject, level) },
      ...history.slice(-20).map(h => ({
        role: h.role === 'assistant' ? 'assistant' : 'user',
        content: h.content,
      })),
      { role: 'user', content: message },
    ];

    const reply = await groqCall(messages, 600);
    res.json({ success: true, reply, usedModel: 'groq/llama-3.3-70b' });
  } catch (err) {
    console.error('AI Tutor error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/tutor/quiz
router.post('/quiz', auth, async (req, res) => {
  try {
    const { subject, topic, level = 'beginner' } = req.body;
    const prompt = `Generate a 5-question ${level}-level quiz on "${topic}" in ${subject}.
Return ONLY a valid JSON array, no markdown, no explanation:
[{"q":"question","options":["A) ...","B) ...","C) ...","D) ..."],"answer":"A","explanation":"..."}]`;

    const raw = await groqCall([{ role: 'user', content: prompt }], 1500);
    const cleaned = raw.replace(/\`\`\`json\n?|\`\`\`\n?/g, '').trim();
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('Could not parse quiz');
    const quiz = JSON.parse(match[0]);
    res.json({ success: true, quiz, topic, subject, level });
  } catch (err) {
    console.error('Quiz error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
