const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const https = require('https');

// ─── Groq call ────────────────────────────────────────────────────────────────
const groqCall = (prompt, maxTokens = 3000) => new Promise((resolve, reject) => {
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

function buildPlannerPrompt({ subjects, examDate, dailyHours, weakTopics, studyStyle }) {
  const daysLeft = Math.max(1, Math.ceil((new Date(examDate) - new Date()) / 86400000));
  const totalHours = daysLeft * dailyHours;
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
4. Each session should be 45-90 min max
5. Final 2 days: only light revision and past papers
6. Session types: "study" | "revision" | "practice" | "rest"
7. Session duration must be in MINUTES (e.g. 60, 90, 45)

Return ONLY valid JSON, no markdown:
{
  "summary": {
    "totalDays": ${daysLeft},
    "totalHours": ${totalHours},
    "subjects": ${JSON.stringify(subjects)},
    "strategy": "Brief 1-2 sentence description of the overall study strategy"
  },
  "dailyPlan": [
    {
      "day": 1,
      "date": "YYYY-MM-DD",
      "restDay": false,
      "totalHours": ${dailyHours},
      "sessions": [
        { "subject": "Physics", "topic": "Kinematics", "duration": 90, "type": "study", "description": "Focus on equations of motion" }
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
    } = req.body;

    if (!subjects?.length) return res.status(400).json({ error: 'Subjects required' });
    if (!examDate) return res.status(400).json({ error: 'Exam date required' });
    if (new Date(examDate) <= new Date()) return res.status(400).json({ error: 'Exam date must be in the future' });

    const payload = { subjects, examDate, dailyHours, weakTopics, studyStyle };
    const raw = await groqCall(buildPlannerPrompt(payload), 4000);
    const plan = parsePlan(raw);

    // Ensure the response shape matches what the frontend expects
    const response = {
      success: true,
      usedModel: 'groq/llama-3.3-70b',
      summary: plan.summary || {
        totalDays: plan.totalDays,
        totalHours: (plan.totalDays || 1) * dailyHours,
        subjects: plan.subjects || subjects,
        strategy: '',
      },
      dailyPlan: plan.dailyPlan || plan.plan || [],
    };

    res.json(response);
  } catch (err) {
    console.error('Study planner error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
