const mongoose = require('mongoose');

// WhatsApp session - links a phone number to a user account
const whatsAppSessionSchema = new mongoose.Schema({
  phone: { 
    type: String, 
    required: true, 
    unique: true, 
    index: true 
  },
  userId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    required: true, 
    index: true 
  },
  isActive: { 
    type: Boolean, 
    default: true 
  },
  linkedAt: { 
    type: Date, 
    default: Date.now 
  },
});

// One-time link codes - stored temporarily with TTL
const linkCodeSchema = new mongoose.Schema({
  code: { 
    type: String, 
    required: true, 
    unique: true,
    uppercase: true,
    trim: true
  },
  userId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    required: true,
    index: true
  },
  used: { 
    type: Boolean, 
    default: false,
    index: true
  },
  expiresAt: { 
    type: Date, 
    required: true,
    default: () => new Date(Date.now() + 10 * 60 * 1000), // 10 minutes
    index: true
  },
  createdAt: { 
    type: Date, 
    default: Date.now, 
    expires: 600  // Auto-delete from DB after 10 minutes
  },
});

// Compound index for faster lookups
linkCodeSchema.index({ code: 1, used: 1, expiresAt: 1 });

const WhatsAppSession = mongoose.model('WhatsAppSession', whatsAppSessionSchema);
const WhatsAppLinkCode = mongoose.model('WhatsAppLinkCode', linkCodeSchema);

module.exports = { WhatsAppSession, WhatsAppLinkCode };
