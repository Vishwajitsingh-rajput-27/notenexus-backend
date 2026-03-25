const express   = require('express');
const router    = express.Router();
const auth      = require('../middleware/auth');
const SavedItem = require('../models/SavedItem');

// ── POST /api/saved ─────────────────────────────────────────────────────────
// Save a new item (mindmap / flashcards / chat / studyplan / examquestions)
router.post('/', auth, async (req, res) => {
  try {
    const { type, name, subject, data } = req.body;
    if (!type || !name || !data) return res.status(400).json({ error: 'type, name and data are required' });
    const item = await SavedItem.create({ userId: req.user.id, type, name, subject: subject || '', data });
    res.status(201).json(item);
  } catch (err) {
    console.error('[saved] POST error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// ── GET /api/saved ──────────────────────────────────────────────────────────
// List saved items; optional ?type= filter
router.get('/', auth, async (req, res) => {
  try {
    const filter = { userId: req.user.id };
    if (req.query.type) filter.type = req.query.type;
    const items = await SavedItem.find(filter).sort({ createdAt: -1 }).limit(100).lean();
    res.json({ items });
  } catch (err) {
    console.error('[saved] GET error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/saved/:id ───────────────────────────────────────────────────
router.delete('/:id', auth, async (req, res) => {
  try {
    const item = await SavedItem.findOneAndDelete({ _id: req.params.id, userId: req.user.id });
    if (!item) return res.status(404).json({ error: 'Not found' });
    res.json({ deleted: true });
  } catch (err) {
    console.error('[saved] DELETE error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
