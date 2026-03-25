const mongoose = require('mongoose');

const INTERVALS = [1, 3, 7, 14, 30];

const reminderSchema = new mongoose.Schema({
  user:           { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  subject:        { type: String, required: true },
  topic:          { type: String, required: true },
  email:          { type: String, required: true },
  phone:          { type: String, default: '' },

  intervalDays:   { type: Number, default: null },
  intervalMinutes:{ type: Number, default: null },
  reminderTime:   { type: String, default: '09:00' },

  oneShotAt:      { type: Date, default: null },
  isOneShot:      { type: Boolean, default: false },

  nextReminder:   { type: Date, default: Date.now, index: true },
  repetitions:    { type: Number, default: 0 },
  active:         { type: Boolean, default: true, index: true },
  lastSentAt:     { type: Date },

  sendEmail:      { type: Boolean, default: true },
  sendWhatsApp:   { type: Boolean, default: false },
}, { timestamps: true });

// Compound indexes for performance
reminderSchema.index({ user: 1, active: 1 });
reminderSchema.index({ active: 1, nextReminder: 1 });

reminderSchema.set('toJSON', { virtuals: true });

module.exports = mongoose.model('Reminder', reminderSchema);
module.exports.INTERVALS = INTERVALS;
