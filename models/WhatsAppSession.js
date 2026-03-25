const mongoose = require('mongoose');

const whatsAppSessionSchema = new mongoose.Schema({
  // Twilio sends numbers as "whatsapp:+1234567890"
  phone:     { type: String, required: true, unique: true, index: true },
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  // FIX: isActive was missing from the schema but referenced everywhere in routes
  isActive:  { type: Boolean, default: true },
  linkedAt:  { type: Date, default: Date.now },
});

// One-time link codes: stored temporarily with TTL
const linkCodeSchema = new mongoose.Schema({
  code:      { type: String, required: true, unique: true },
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  // FIX: 'used' was missing — route queries { used: false } so codes never matched
  used:      { type: Boolean, default: false },
  // FIX: 'expiresAt' was missing — route queries expiresAt: { $gt: new Date() } so codes never matched
  expiresAt: { type: Date, default: () => new Date(Date.now() + 10 * 60 * 1000) },
  createdAt: { type: Date, default: Date.now, expires: 600 }, // auto-delete from DB after 10 min
});

const WhatsAppSession = mongoose.model('WhatsAppSession', whatsAppSessionSchema);
const WhatsAppLinkCode = mongoose.model('WhatsAppLinkCode', linkCodeSchema);

module.exports = { WhatsAppSession, WhatsAppLinkCode };
