const express      = require('express');
const asyncHandler = require('express-async-handler');
const Note         = require('../models/Note');
const protect = require('../middleware/auth');
const { upload }   = require('../config/cloudinary');
const { extractFromImage, extractFromPDF, extractFromYouTube, extractFromVoice } = require('../services/ingestionService');
const { detectSubjectChapter, translateToEnglish } = require('../services/aiService');
const { storeEmbedding, deleteEmbedding } = require('../services/vectorService');
const { v4: uuidv4 } = require('uuid');

const router = express.Router();
router.use(protect);

// ── POST /api/notes/upload ─────────────────────────────────────────────────
router.post('/upload', upload.single('file'), asyncHandler(async (req, res) => {
  const { sourceType, youtubeUrl, title } = req.body;
  const userId = req.user._id.toString();

  let extractedText = '';
  let fileUrl = '';

  if (sourceType === 'youtube' && youtubeUrl) {
    extractedText = await extractFromYouTube(youtubeUrl);
    fileUrl = youtubeUrl;
  } else if (req.file) {
    fileUrl = req.file.path;
    if (sourceType === 'pdf')   extractedText = await extractFromPDF(fileUrl);
    if (sourceType === 'image') extractedText = await extractFromImage(fileUrl);
    if (sourceType === 'voice') extractedText = await extractFromVoice(fileUrl);
  } else {
    return res.status(400).json({ message: 'Provide a file or YouTube URL' });
  }

  if (!extractedText || !extractedText.trim()) {
    return res.status(422).json({ message: 'Could not extract text from source' });
  }

  // Auto-translate to English if content is in another language
  console.log('Checking language and translating if needed...');
  const englishText = await translateToEnglish(extractedText);

  const meta     = await detectSubjectChapter(englishText);
  const noteId   = uuidv4();
  const autoTitle = title || `${meta.subject} — ${meta.chapter}`;

  const note = await Note.create({
    userId,
    title: autoTitle,
    content: englishText,        // Save translated English content
    sourceType,
    fileUrl,
    subject:   meta.subject,
    chapter:   meta.chapter,
    keywords:  meta.keywords || [],
    pineconeId: noteId,
  });

  await storeEmbedding(noteId, englishText, {
    userId,
    noteId:    note._id.toString(),
    subject:   meta.subject,
    chapter:   meta.chapter,
    sourceType,
    fileUrl,
    title:     autoTitle,
  });

  res.status(201).json({
    noteId:    note._id,
    title:     autoTitle,
    subject:   meta.subject,
    chapter:   meta.chapter,
    keywords:  meta.keywords,
    sourceType,
    fileUrl,
    preview:   englishText.slice(0, 300),
    wordCount: englishText.split(/\s+/).length,
  });
}));

// ── GET /api/notes ─────────────────────────────────────────────────────────
router.get('/', asyncHandler(async (req, res) => {
  const { subject, limit = 50 } = req.query;
  const query = { userId: req.user._id };
  if (subject) query.subject = subject;
  const notes = await Note.find(query).sort({ createdAt: -1 }).limit(Number(limit)).select('-content');
  res.json({ notes, count: notes.length });
}));

// ── GET /api/notes/subjects ────────────────────────────────────────────────
router.get('/subjects', asyncHandler(async (req, res) => {
  const subjects = await Note.distinct('subject', { userId: req.user._id });
  res.json({ subjects });
}));

// ── GET /api/notes/shared ──────────────────────────────────────────────────
router.get('/shared', asyncHandler(async (req, res) => {
  const notes = await Note.find({ isShared: true }).sort({ upvotes: -1 }).limit(30).select('-content').populate('userId', 'name');
  res.json({ notes, count: notes.length });
}));

// ── GET /api/notes/:id ─────────────────────────────────────────────────────
router.get('/:id', asyncHandler(async (req, res) => {
  const note = await Note.findOne({ _id: req.params.id, userId: req.user._id });
  if (!note) return res.status(404).json({ message: 'Note not found' });
  res.json(note);
}));

// ── DELETE /api/notes/:id ──────────────────────────────────────────────────
router.delete('/:id', asyncHandler(async (req, res) => {
  const note = await Note.findOneAndDelete({ _id: req.params.id, userId: req.user._id });
  if (!note) return res.status(404).json({ message: 'Note not found' });
  if (note.pineconeId) await deleteEmbedding(note.pineconeId);
  res.json({ success: true });
}));

// ── PATCH /api/notes/:id/share ─────────────────────────────────────────────
router.patch('/:id/share', asyncHandler(async (req, res) => {
  const note = await Note.findOneAndUpdate(
    { _id: req.params.id, userId: req.user._id },
    { isShared: req.body.shared },
    { new: true }
  );
  if (!note) return res.status(404).json({ message: 'Note not found' });
  res.json({ isShared: note.isShared });
}));

// ── POST /api/notes/:id/upvote ─────────────────────────────────────────────
router.post('/:id/upvote', asyncHandler(async (req, res) => {
  const note = await Note.findById(req.params.id);
  if (!note) return res.status(404).json({ message: 'Note not found' });
  const uid = req.user._id.toString();
  const already = note.upvotedBy.map(String).includes(uid);
  if (already) {
    note.upvotes   -= 1;
    note.upvotedBy  = note.upvotedBy.filter(id => id.toString() !== uid);
  } else {
    note.upvotes   += 1;
    note.upvotedBy.push(req.user._id);
  }
  await note.save();
  res.json({ upvotes: note.upvotes, upvoted: !already });
}));

module.exports = router;
