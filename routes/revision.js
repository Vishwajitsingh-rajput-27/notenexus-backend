const express      = require('express');
const asyncHandler = require('express-async-handler');
const auth = require('../middleware/auth');
const { generateSummary, generateFlashcards, generateQuestions, generateMindmap } = require('../services/aiService');

const router = express.Router();
router.use(auth);

// POST /api/revision
router.post('/', asyncHandler(async (req, res) => {
  const { text, type } = req.body;
  if (!text?.trim() || text.trim().length < 20) return res.status(400).json({ message: 'Text too short' });

  let result;
  if      (type === 'summary')    result = await generateSummary(text);
  else if (type === 'flashcards') result = await generateFlashcards(text);
  else if (type === 'questions')  result = await generateQuestions(text);
  else if (type === 'mindmap')    result = await generateMindmap(text);
  else return res.status(400).json({ message: 'type must be: summary | flashcards | questions | mindmap' });

  res.json({ type, result });
}));

// POST /api/revision/all — generate everything at once
router.post('/all', asyncHandler(async (req, res) => {
  const { text } = req.body;
  if (!text?.trim() || text.trim().length < 20) return res.status(400).json({ message: 'Text too short' });
  const [summary, flashcards, questions, mindmap] = await Promise.all([
    generateSummary(text),
    generateFlashcards(text),
    generateQuestions(text),
    generateMindmap(text),
  ]);
  res.json({ summary, flashcards, questions, mindmap });
}));

module.exports = router;
