const mongoose = require('mongoose');

// Spaced repetition intervals in days
const INTERVALS = [1, 3, 7, 14, 30];

const reminderSchema = new mongoose.Schema({
  user:          { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  subject:       { type: String, required: true },
  topic:         { type: String, required: true },
  email:         { type: String, required: true },
  phone:         { type: String, default: '' },           // optional WhatsApp
  intervalDays:  { type: Number, default: 1 },
  nextReminder:  { type: Date, default: Date.now },
  repetitions:   { type: Number, default: 0 },
  active:        { type: Boolean, default: true },
  lastSentAt:    { type: Date },
}, { timestamps: true });

// Virtual: next interval label
reminderSchema.virtual('nextIntervalLabel').get(function () {
  const idx = Math.min(this.repetitions, INTERVALS.length - 1);
  return `${INTERVALS[idx]} day(s)`;
});

reminderSchema.set('toJSON', { virtuals: true });

module.exports = mongoose.model('Reminder', reminderSchema);
module.exports.INTERVALS = INTERVALS;
