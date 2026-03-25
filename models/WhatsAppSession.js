const mongoose = require('mongoose');

const whatsAppSessionSchema = new mongoose.Schema({
  // Twilio sends numbers as "whatsapp:+1234567890"
  phone:     { type: String, required: true, unique: true, index: true },
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  linkedAt:  { type: Date, default: Date.now },
});

// One-time link codes: stored temporarily in memory (or here with TTL)
const linkCodeSchema = new mongoose.Schema({
  code:      { type: String, required: true, unique: true },
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  createdAt: { type: Date, default: Date.now, expires: 600 }, // auto-delete after 10 min
});

const WhatsAppSession = mongoose.model('WhatsAppSession', whatsAppSessionSchema);
const WhatsAppLinkCode = mongoose.model('WhatsAppLinkCode', linkCodeSchema);

module.exports = { WhatsAppSession, WhatsAppLinkCode };
