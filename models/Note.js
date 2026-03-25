// models/Note.js  —  NoteNexus
// CHANGE: added extractedImages field (array of Cloudinary URLs)

const mongoose = require('mongoose');

const noteSchema = new mongoose.Schema({
  userId:          { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  title:           { type: String, required: true },
  content:         { type: String, default: '' },
  sourceType:      { type: String, enum: ['pdf', 'image', 'youtube', 'voice', 'whatsapp', 'text'], required: true },
  fileUrl:         { type: String, default: '' },
  subject:         { type: String, default: 'General' },
  chapter:         { type: String, default: 'Uncategorized' },
  keywords:        [String],
  isShared:        { type: Boolean, default: false },
  upvotes:         { type: Number, default: 0 },
  upvotedBy:       [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  pineconeId:      { type: String, default: '' },

  // ★ NEW: images extracted from the uploaded PDF
  extractedImages: {
    type: [String],   // array of Cloudinary image URLs
    default: [],
  },

  createdAt: { type: Date, default: Date.now },
});

noteSchema.index({ userId: 1, subject: 1 });
noteSchema.index({ isShared: 1, upvotes: -1 });

module.exports = mongoose.model('Note', noteSchema);
