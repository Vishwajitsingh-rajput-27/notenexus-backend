const express = require('express');
const router = express.Router();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const auth = require('../middleware/auth');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ─── Exam Predictor ────────────────────────────────────────────────────────
// Uses Gemini (primary) with Grok fallback
// POST /api/exam/predict
// Body: { noteContent, subject, examType, count, aiModel }
// ──────────────────────────────────────────────────────────────────────────

async function predictWithGemini(noteContent, subject, examType, count) {
  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
  const prompt = buildPrompt(noteContent, subject, examType, count);
  const result = await model.generateContent(prompt);
  return parseQuestions(result.response.text());
}

async function predictWithGrok(noteContent, subject, examType, count) {
  const prompt = buildPrompt(noteContent, subject, examType, count);
  const response = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.GROK_API_KEY || process.env.XAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'grok-beta',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 2000,
    }),
  });
  const data = await response.json();
  return parseQuestions(data.choices[0].message.content);
}

function buildPrompt(noteContent, subject, examType, count) {
  return `You are an expert ${subject} examiner with 20 years experience.
Analyze this content and generate ${count} highly likely exam questions.
Exam type: ${examType}

Rules:
- Base questions ONLY on the provided content
- Include a mix of difficulty levels
- For MCQ: include 4 options with correct answer marked
- For short/long: include a model answer
- Identify the specific topic each question tests

Return ONLY a valid JSON array, no markdown, no explanation:
[{
  "question": "...",
  "type": "MCQ|short|long",
  "difficulty": "Easy|Medium|Hard",
  "topic": "...",
  "options": ["A)..","B)..","C)..","D).."],
  "answer": "..."
}]

Content to analyze:
${noteContent.slice(0, 4000)}`;
}

function parseQuestions(text) {
  // Strip markdown code fences if present
  const cleaned = text.replace(/```json\n?|\```\n?/g, '').trim();
  const match = cleaned.match(/\[[\s\S]*\]/);
  if (!match) throw new Error('Could not parse questions from AI response');
  return JSON.parse(match[0]);
}

// POST /api/exam/predict
router.post('/predict', auth, async (req, res) => {
  try {
    const {
      noteContent,
      subject = 'General',
      examType = 'mixed',
      count = 10,
      aiModel = 'gemini', // 'gemini' | 'grok'
    } = req.body;

    if (!noteContent || noteContent.length < 50) {
      return res.status(400).json({ error: 'Please provide more content (at least 50 characters)' });
    }

    let questions;
    let usedModel = aiModel;

    try {
      if (aiModel === 'grok' && (process.env.GROK_API_KEY || process.env.XAI_API_KEY)) {
        questions = await predictWithGrok(noteContent, subject, examType, count);
      } else {
        questions = await predictWithGemini(noteContent, subject, examType, count);
        usedModel = 'gemini';
      }
    } catch (primaryErr) {
      console.warn(`Primary model (${aiModel}) failed, trying fallback:`, primaryErr.message);
      // Fallback to the other model
      if (usedModel === 'gemini') {
        questions = await predictWithGrok(noteContent, subject, examType, count);
        usedModel = 'grok (fallback)';
      } else {
        questions = await predictWithGemini(noteContent, subject, examType, count);
        usedModel = 'gemini (fallback)';
      }
    }

    // Stats
    const stats = questions.reduce((acc, q) => {
      acc[q.difficulty] = (acc[q.difficulty] || 0) + 1;
      return acc;
    }, {});

    res.json({
      success: true,
      questions,
      meta: { subject, examType, count: questions.length, usedModel, stats },
    });
  } catch (err) {
    console.error('Exam predictor error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/exam/subjects — unique subjects from user's notes
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
