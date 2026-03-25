const mongoose = require('mongoose');

// Preset spaced-repetition intervals in days
const INTERVALS = [1, 3, 7, 14, 30];

const reminderSchema = new mongoose.Schema({
  user:          { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  subject:       { type: String, required: true },
  topic:         { type: String, required: true },
  email:         { type: String, required: true },
  phone:         { type: String, default: '' },        // WhatsApp number e.g. whatsapp:+447...

  // ── Schedule fields ────────────────────────────────────────────────────────
  intervalDays:  { type: Number, default: 1 },         // days between repeats (for repeating)
  reminderTime:  { type: String, default: '09:00' },   // HH:MM local send time

  // One-shot: if set, fires once at this exact datetime then deactivates
  oneShotAt:     { type: Date, default: null },
  isOneShot:     { type: Boolean, default: false },

  // ── State ──────────────────────────────────────────────────────────────────
  nextReminder:  { type: Date, default: Date.now },
  repetitions:   { type: Number, default: 0 },
  active:        { type: Boolean, default: true },
  lastSentAt:    { type: Date },

  // ── Delivery channels ──────────────────────────────────────────────────────
  sendEmail:     { type: Boolean, default: true },
  sendWhatsApp:  { type: Boolean, default: false },
}, { timestamps: true });

reminderSchema.set('toJSON', { virtuals: true });

module.exports = mongoose.model('Reminder', reminderSchema);
module.exports.INTERVALS = INTERVALS;
