const mongoose = require('mongoose');

const savedItemSchema = new mongoose.Schema({
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type:      { type: String, enum: ['mindmap', 'flashcards', 'chat', 'studyplan', 'examquestions', 'quiz'], required: true },
  name:      { type: String, required: true, trim: true },
  subject:   { type: String, default: '' },
  data:      { type: mongoose.Schema.Types.Mixed, required: true },
  createdAt: { type: Date, default: Date.now },
});

savedItemSchema.index({ userId: 1, type: 1, createdAt: -1 });

module.exports = mongoose.model('SavedItem', savedItemSchema);
