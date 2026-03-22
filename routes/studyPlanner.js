const express = require('express');
const router = express.Router();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const auth = require('../middleware/auth');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ─── Smart Study Planner ───────────────────────────────────────────────────
// POST /api/planner/generate  → AI generates day-by-day plan
// POST /api/planner/save      → save plan to MongoDB
// GET  /api/planner/my        → get user's saved plans
// ──────────────────────────────────────────────────────────────────────────

async function generateWithGemini(payload) {
  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
  const result = await model.generateContent(buildPlannerPrompt(payload));
  return parsePlan(result.response.text());
}

async function generateWithGrok(payload) {
  const response = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.GROK_API_KEY || process.env.XAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'grok-beta',
      messages: [{ role: 'user', content: buildPlannerPrompt(payload) }],
      max_tokens: 3000,
    }),
  });
  const data = await response.json();
  return parsePlan(data.choices[0].message.content);
}

function buildPlannerPrompt({ subjects, examDate, dailyHours, weakTopics, studyStyle }) {
  const daysLeft = Math.max(1, Math.ceil((new Date(examDate) - new Date()) / 86400000));
  return `Create a detailed study plan for a student preparing for exams.

Student details:
- Subjects: ${subjects.join(', ')}
- Days until exam: ${daysLeft}
- Daily study hours available: ${dailyHours}
- Weak topics needing extra time: ${weakTopics || 'none specified'}
- Preferred study style: ${studyStyle || 'mixed'}

Planning rules:
1. Distribute subjects proportionally; give 40% more time to weak topics
2. Include revision sessions in the last 20% of days
3. Add 1 full rest day every 6-7 days (mark as restDay: true)
4. Each session should be 45-90 min max (include short break sessions)
5. Final 2 days: only light revision and past papers
6. Session types: "study" | "revision" | "practice" | "rest"

Return ONLY valid JSON, no markdown:
{
  "totalDays": ${daysLeft},
  "examDate": "${examDate}",
  "subjects": ${JSON.stringify(subjects)},
  "plan": [
    {
      "day": 1,
      "date": "YYYY-MM-DD",
      "restDay": false,
      "totalHours": 4,
      "sessions": [
        { "subject": "Physics", "topic": "Kinematics", "duration": 1.5, "type": "study", "notes": "Focus on equations of motion" }
      ]
    }
  ]
}`;
}

function parsePlan(text) {
  const cleaned = text.replace(/```json\n?|```\n?/g, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Could not parse study plan from AI response');
  return JSON.parse(match[0]);
}

// POST /api/planner/generate
router.post('/generate', auth, async (req, res) => {
  try {
    const {
      subjects,
      examDate,
      dailyHours = 4,
      weakTopics = '',
      studyStyle = 'mixed',
      aiModel = 'gemini',
    } = req.body;

    if (!subjects?.length) return res.status(400).json({ error: 'Subjects required' });
    if (!examDate) return res.status(400).json({ error: 'Exam date required' });
    if (new Date(examDate) <= new Date()) return res.status(400).json({ error: 'Exam date must be in the future' });

    const payload = { subjects, examDate, dailyHours, weakTopics, studyStyle };
    let plan;
    let usedModel = aiModel;

    try {
      plan = aiModel === 'grok' && (process.env.GROK_API_KEY || process.env.XAI_API_KEY)
        ? await generateWithGrok(payload)
        : await generateWithGemini(payload);
    } catch (err) {
      console.warn('Primary model failed, using fallback:', err.message);
      plan = usedModel === 'gemini' ? await generateWithGrok(payload) : await generateWithGemini(payload);
      usedModel += ' (fallback)';
    }

    res.json({ success: true, usedModel, ...plan });
  } catch (err) {
    console.error('Study planner error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
