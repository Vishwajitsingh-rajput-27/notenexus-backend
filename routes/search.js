const express      = require('express');
const asyncHandler = require('express-async-handler');
const auth = require('../middleware/auth');
const { semanticSearch } = require('../services/vectorService');

const router = express.Router();
router.use(auth);

// POST /api/search
router.post('/', asyncHandler(async (req, res) => {
  const { query, topK = 8 } = req.body;
  if (!query?.trim()) return res.status(400).json({ message: 'Query is required' });
  const results = await semanticSearch(query, req.user._id.toString(), topK);
  res.json({ query, results, count: results.length });
}));

module.exports = router;
