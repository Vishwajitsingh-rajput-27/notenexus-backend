const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const https = require('https');

const groqCall = (prompt, maxTokens = 2048) => new Promise((resolve, reject) => {
  const body = JSON.stringify({
    model: 'llama-3.3-70b-versatile',
    messages: [{ role: 'user', content: prompt }],
    max_tokens: maxTokens,
    temperature: 0.3,
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

const extractJSON = (raw, type = 'array') => {
  try {
    raw = (raw || '').replace(/```json|```/gi, '').trim();
    if (type === 'array') {
      const s = raw.indexOf('['), e = raw.lastIndexOf(']');
      if (s !== -1 && e !== -1) return JSON.parse(raw.slice(s, e + 1));
    } else {
      const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
      if (s !== -1 && e !== -1) return JSON.parse(raw.slice(s, e + 1));
    }
    return JSON.parse(raw);
  } catch { return type === 'array' ? [] : {}; }
};

router.post('/predict', auth, async (req, res) => {
  try {
    const { noteContent, subject = 'General', examType = 'mixed', count = 10 } = req.body;

    if (!noteContent || noteContent.length < 50) {
      return res.status(400).json({ error: 'Please provide more content (at least 50 characters)' });
    }

    const prompt = `You are an expert ${subject} examiner. Analyze this content and generate ${count} highly likely exam questions.
Exam type: ${examType}

Rules:
- Base questions ONLY on the content provided
- For MCQ: include options array with 4 items like ["A) ...", "B) ...", "C) ...", "D) ..."]
- For short/long: options array should be empty []
- Always include a clear model answer in the answer field
- Mix difficulty: Easy, Medium, Hard

Return ONLY a valid JSON array, no markdown, no extra text:
[{"question":"...","type":"MCQ","difficulty":"Easy","topic":"...","options":["A)...","B)...","C)...","D)..."],"answer":"The correct answer is B) ... because ..."}]

Content:
${noteContent.slice(0, 4000)}`;

    const raw = await groqCall(prompt, 3000);
    const questions = extractJSON(raw, 'array');

    if (!Array.isArray(questions) || questions.length === 0) {
      return res.status(500).json({ error: 'Could not generate questions. Try with more detailed notes.' });
    }

    const stats = questions.reduce((acc, q) => {
      acc[q.difficulty] = (acc[q.difficulty] || 0) + 1;
      return acc;
    }, {});

    res.json({
      success: true,
      questions,
      meta: { subject, examType, count: questions.length, usedModel: 'groq/llama-3.3-70b', stats },
    });
  } catch (err) {
    console.error('Exam predictor error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/subjects', auth, async (req, res) => {
  try {
    const Note = require('../models/Note');
    const subjects = await Note.distinct('subject', { user: req.user.id });
    res.json({ subjects: subjects.filter(Boolean) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
