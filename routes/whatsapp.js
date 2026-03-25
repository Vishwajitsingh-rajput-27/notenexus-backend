// routes/whatsapp.js — NoteNexus WhatsApp Bot
// Complete fixed version

const express = require('express');
const router = express.Router();
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');
const { Readable } = require('stream');
const { v4: uuidv4 } = require('uuid');

const auth = require('../middleware/auth');
const { WhatsAppSession, WhatsAppLinkCode } = require('../models/WhatsAppSession');
const Note = require('../models/Note');
const SavedItem = require('../models/SavedItem');
const Reminder = require('../models/Reminder');
const { upload, cloudinary } = require('../config/cloudinary');

const {
  extractFromPDF,
  extractFromImage,
  extractImagesFromPDF,
} = require('../services/ingestionService');
const { detectSubjectChapter, translateToEnglish } = require('../services/aiService');
const { storeEmbedding } = require('../services/vectorService');

// ═══════════════════════════════════════════════════════════════════════════════
// DEBUG ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/webhook', (req, res) => {
  console.log('[webhook GET] Webhook is reachable');
  res.send('✅ WhatsApp webhook is active. Use POST for Twilio messages.');
});

router.get('/debug-env', (req, res) => {
  res.json({
    timestamp: new Date().toISOString(),
    TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID ? `SET (${process.env.TWILIO_ACCOUNT_SID.slice(0, 4)}...)` : '❌ MISSING',
    TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN ? `SET (${process.env.TWILIO_AUTH_TOKEN.slice(0, 4)}...)` : '❌ MISSING',
    TWILIO_WHATSAPP_NUMBER: process.env.TWILIO_WHATSAPP_NUMBER || '❌ MISSING',
    NODE_ENV: process.env.NODE_ENV || 'not set',
  });
});

router.get('/test-twilio', async (req, res) => {
  try {
    if (!process.env.TWILIO_ACCOUNT_SID) {
      return res.json({ success: false, error: 'TWILIO_ACCOUNT_SID not set' });
    }
    if (!process.env.TWILIO_AUTH_TOKEN) {
      return res.json({ success: false, error: 'TWILIO_AUTH_TOKEN not set' });
    }
    if (!process.env.TWILIO_WHATSAPP_NUMBER) {
      return res.json({ success: false, error: 'TWILIO_WHATSAPP_NUMBER not set' });
    }

    let twilio;
    try {
      twilio = require('twilio');
    } catch (err) {
      return res.json({ success: false, error: 'Twilio package not installed. Run: npm install twilio' });
    }

    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const account = await client.api.accounts(process.env.TWILIO_ACCOUNT_SID).fetch();

    res.json({
      success: true,
      message: '✅ Twilio credentials are valid',
      account: {
        sid: account.sid,
        friendlyName: account.friendlyName,
        status: account.status,
      },
      whatsappNumber: process.env.TWILIO_WHATSAPP_NUMBER,
    });
  } catch (err) {
    res.json({
      success: false,
      error: err.message,
    });
  }
});

router.get('/debug-codes', async (req, res) => {
  try {
    const allCodes = await WhatsAppLinkCode.find({}).sort({ createdAt: -1 }).limit(10);
    const activeCodes = await WhatsAppLinkCode.find({ used: false, expiresAt: { $gt: new Date() } });

    res.json({
      success: true,
      totalCodes: allCodes.length,
      activeCodes: activeCodes.length,
      recentCodes: allCodes.map(c => ({
        code: c.code,
        used: c.used,
        expiresAt: c.expiresAt,
        expired: c.expiresAt < new Date(),
        createdAt: c.createdAt,
      })),
    });
  } catch (err) {
    res.json({
      success: false,
      error: err.message,
    });
  }
});

// Temporary endpoint to clean up duplicate sessions
router.delete('/reset/:phone', async (req, res) => {
  try {
    const phone = `whatsapp:+${req.params.phone}`;
    const result = await WhatsAppSession.deleteMany({ phone });
    res.json({
      success: true,
      message: `Deleted ${result.deletedCount} sessions for ${phone}`,
    });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GROQ AI HELPER
// ═══════════════════════════════════════════════════════════════════════════════

async function askGroq(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 500,
      temperature: 0.7,
    });

    const options = {
      hostname: 'api.groq.com',
      path: '/openai/v1/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message));
          if (!parsed.choices?.[0]?.message?.content) return reject(new Error('Empty response'));
          resolve(parsed.choices[0].message.content);
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(25000, () => {
      req.destroy();
      reject(new Error('Groq timeout'));
    });
    req.write(body);
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// TWILIO HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function getTwilioClient() {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    throw new Error('Twilio environment variables not set');
  }
  return require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

async function sendWhatsApp(to, body) {
  try {
    // Don't send if To = From (would cause error)
    if (to === process.env.TWILIO_WHATSAPP_NUMBER) {
      console.log('[sendWhatsApp] ⚠️ Skipping - cannot send to same number as From');
      return;
    }

    const client = getTwilioClient();
    await client.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to,
      body: body.slice(0, 1600),
    });
    console.log('[sendWhatsApp] ✅ Message sent to:', to);
  } catch (err) {
    console.error('[sendWhatsApp] ❌ Failed:', err.message);
  }
}

async function sendWhatsAppMedia(to, body, mediaUrl) {
  try {
    if (to === process.env.TWILIO_WHATSAPP_NUMBER) {
      console.log('[sendWhatsAppMedia] ⚠️ Skipping - cannot send to same number');
      return;
    }

    const client = getTwilioClient();
    await client.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to,
      body: body.slice(0, 1600),
      mediaUrl: [mediaUrl],
    });
    console.log('[sendWhatsAppMedia] ✅ Media sent to:', to);
  } catch (err) {
    console.error('[sendWhatsAppMedia] ❌ Failed:', err.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// FORMAT HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function formatNotesList(notes) {
  if (!notes.length) {
    return '📭 You have no notes yet.\n\nUpload notes at notenexus.vercel.app';
  }

  const lines = notes.slice(0, 10).map((n, i) => {
    const date = new Date(n.createdAt).toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'short',
    });
    const imgBadge = n.extractedImages?.length ? ` 🖼️×${n.extractedImages.length}` : '';
    return `${i + 1}. 📄 *${n.title}*${imgBadge}\n   Subject: ${n.subject} | ${n.chapter}\n   Added: ${date}`;
  });

  const extra = notes.length > 10 ? `\n\n...and ${notes.length - 10} more notes.` : '';

  return `📚 *Your Notes* (${notes.length} total)\n\n${lines.join('\n\n')}${extra}\n\nType a number to read a note, or *images <N>* to see PDF images.`;
}

function formatNoteDetail(note) {
  const sourceIcon = {
    pdf: '📄',
    image: '🖼️',
    youtube: '🎥',
    voice: '🎙️',
    whatsapp: '💬',
    text: '📝',
  };
  const icon = sourceIcon[note.sourceType] || '📄';

  const lines = [];
  lines.push(`${icon} *${note.title}*`);
  lines.push(`📚 Subject: ${note.subject} | ${note.chapter}`);

  if (note.extractedImages?.length) {
    lines.push(`🖼️ *${note.extractedImages.length} images extracted* — type *images <N>* to view`);
  }

  if (note.keywords?.length) {
    lines.push(`🏷️ Keywords: ${note.keywords.join(', ')}`);
  }

  lines.push('');

  if (note.content) {
    lines.push(note.content.slice(0, 800));
    if (note.content.length > 800) {
      lines.push('\n_(content truncated — open app for full note)_');
    }
  }

  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════════
// FILE DOWNLOAD HELPER
// ═══════════════════════════════════════════════════════════════════════════════

function fetchBuffer(urlStr) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const lib = parsed.protocol === 'https:' ? https : http;

    const headers = {};

    if (parsed.hostname.includes('twilio.com')) {
      headers['Authorization'] =
        'Basic ' +
        Buffer.from(
          `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
        ).toString('base64');
    }

    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers,
    };

    const req = lib.get(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });

    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Download timeout'));
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// HANDLE INCOMING PDF
// ═══════════════════════════════════════════════════════════════════════════════

async function handleIncomingPDF(session, mediaUrl, mediaContentType, from) {
  try {
    await sendWhatsApp(from, '📄 PDF received! Processing text and extracting images... ⏳');

    const pdfBuffer = await fetchBuffer(mediaUrl);
    console.log('[handleIncomingPDF] Downloaded PDF, size:', pdfBuffer.length);

    const uploadedPdf = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { resource_type: 'raw', format: 'pdf', folder: 'notenexus/whatsapp-pdfs' },
        (err, result) => {
          if (err) reject(err);
          else resolve(result);
        }
      );
      Readable.from(pdfBuffer).pipe(stream);
    });

    const pdfCloudinaryUrl = uploadedPdf.secure_url;
    console.log('[handleIncomingPDF] Uploaded to Cloudinary:', pdfCloudinaryUrl);

    const [extractedText, imgResult] = await Promise.all([
      extractFromPDF(pdfCloudinaryUrl),
      extractImagesFromPDF(pdfCloudinaryUrl, { maxPages: 10, extractEmbedded: true }),
    ]);

    if (!extractedText?.trim()) {
      return sendWhatsApp(
        from,
        '⚠️ Could not extract text from that PDF. Please try a text-based PDF.'
      );
    }

    const englishText = await translateToEnglish(extractedText);
    const meta = await detectSubjectChapter(englishText);
    const autoTitle = `${meta.subject} — ${meta.chapter}`;
    const noteId = uuidv4();

    const allImages = [...(imgResult.pageImages || []), ...(imgResult.embeddedImages || [])];

    const note = await Note.create({
      userId: session.userId,
      title: autoTitle,
      content: englishText,
      sourceType: 'whatsapp',
      fileUrl: pdfCloudinaryUrl,
      subject: meta.subject,
      chapter: meta.chapter,
      keywords: meta.keywords || [],
      pineconeId: noteId,
      extractedImages: allImages,
    });

    await storeEmbedding(noteId, englishText, {
      userId: session.userId.toString(),
      noteId: note._id.toString(),
      subject: meta.subject,
      chapter: meta.chapter,
      sourceType: 'whatsapp',
      fileUrl: pdfCloudinaryUrl,
      title: autoTitle,
    });

    const summary = `✅ *PDF Saved!*\n\n📚 *${autoTitle}*\nSubject: ${meta.subject}\nChapter: ${meta.chapter}\nKeywords: ${(meta.keywords || []).slice(0, 5).join(', ')}\n🖼️ ${allImages.length} images extracted\n📝 ${englishText.split(/\s+/).length} words\n\n${englishText.slice(0, 400)}${englishText.length > 400 ? '...' : ''}`;

    await sendWhatsApp(from, summary);

    if (allImages.length > 0) {
      await sendWhatsAppMedia(
        from,
        `🖼️ Page 1 of your PDF (${allImages.length} total pages extracted):`,
        allImages[0]
      );
    }

    console.log('[handleIncomingPDF] ✅ PDF processed successfully');
  } catch (err) {
    console.error('[handleIncomingPDF] ❌ Error:', err);
    await sendWhatsApp(
      from,
      '❌ Failed to process your PDF. Please try again or upload at notenexus.vercel.app'
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HANDLE INCOMING IMAGE
// ═══════════════════════════════════════════════════════════════════════════════

async function handleIncomingImage(session, mediaUrl, from) {
  try {
    await sendWhatsApp(from, '🖼️ Image received! Extracting text... ⏳');

    const extractedText = await extractFromImage(mediaUrl);

    if (!extractedText?.trim()) {
      return sendWhatsApp(
        from,
        '⚠️ Could not extract text from that image. Is it a clear photo of notes?'
      );
    }

    const englishText = await translateToEnglish(extractedText);
    const meta = await detectSubjectChapter(englishText);
    const autoTitle = `${meta.subject} — ${meta.chapter}`;
    const noteId = uuidv4();

    const note = await Note.create({
      userId: session.userId,
      title: autoTitle,
      content: englishText,
      sourceType: 'whatsapp',
      fileUrl: mediaUrl,
      subject: meta.subject,
      chapter: meta.chapter,
      keywords: meta.keywords || [],
      pineconeId: noteId,
    });

    await storeEmbedding(noteId, englishText, {
      userId: session.userId.toString(),
      noteId: note._id.toString(),
      subject: meta.subject,
      chapter: meta.chapter,
      sourceType: 'whatsapp',
      fileUrl: mediaUrl,
      title: autoTitle,
    });

    await sendWhatsApp(
      from,
      `✅ *Image Note Saved!*\n\n📚 *${autoTitle}*\nSubject: ${meta.subject}\nChapter: ${meta.chapter}\n\n${englishText.slice(0, 500)}`
    );

    console.log('[handleIncomingImage] ✅ Image processed successfully');
  } catch (err) {
    console.error('[handleIncomingImage] ❌ Error:', err);
    await sendWhatsApp(from, '❌ Failed to process your image. Please try again.');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// WEBHOOK — Twilio sends ALL incoming WhatsApp messages here
// ═══════════════════════════════════════════════════════════════════════════════

router.post('/webhook', async (req, res) => {
  console.log('═══════════════════════════════════════════════════════');
  console.log('[webhook] 📥 INCOMING MESSAGE');
  console.log('[webhook] From:', req.body.From);
  console.log('[webhook] Body:', req.body.Body);
  console.log('[webhook] NumMedia:', req.body.NumMedia);
  console.log('═══════════════════════════════════════════════════════');

  res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');

  try {
    const { From, Body, NumMedia, MediaUrl0, MediaContentType0 } = req.body;

    const from = From;
    const text = (Body || '').trim().toLowerCase();

    // IGNORE messages FROM the Twilio number itself
    if (from === process.env.TWILIO_WHATSAPP_NUMBER) {
      console.log('[webhook] ⚠️ Ignoring message from Twilio number itself');
      return;
    }

    console.log('[webhook] Message from:', from, '| Text:', text, '| NumMedia:', NumMedia);

    const session = await WhatsAppSession.findOne({ phone: from, isActive: true });
    console.log('[webhook] Session found:', !!session);

    if (!session) {
      const parts = text.split(' ');
      console.log('[webhook] Not linked. Parts:', parts);

      if (parts[0] === 'link' && parts[1]) {
        const code = parts[1].toUpperCase();
        console.log('[webhook] 🔗 Link attempt with code:', code);

        const linkDoc = await WhatsAppLinkCode.findOne({
          code,
          used: false,
          expiresAt: { $gt: new Date() },
        });

        console.log('[webhook] LinkCode found:', !!linkDoc);

        if (linkDoc) {
          // ============================================================
          // FIX: Check if session already exists, update instead of create
          // ============================================================
          const existingSession = await WhatsAppSession.findOne({ phone: from });

          if (existingSession) {
            console.log('[webhook] ⚠️ Session already exists, updating...');
            
            await WhatsAppSession.updateOne(
              { phone: from },
              {
                userId: linkDoc.userId,
                isActive: true,
                linkedAt: new Date(),
              }
            );
            console.log('[webhook] ✅ Existing session updated');
          } else {
            const newSession = await WhatsAppSession.create({
              userId: linkDoc.userId,
              phone: from,
              isActive: true,
            });
            console.log('[webhook] ✅ New session created:', newSession._id);
          }

          await WhatsAppLinkCode.updateOne({ _id: linkDoc._id }, { used: true });
          console.log('[webhook] ✅ Code marked as used');

          await sendWhatsApp(
            from,
            '✅ *NoteNexus linked!*\n\nCommands:\n• *notes* — list your notes\n• *help* — full command list\n\nYou can also *send a PDF* or *image* directly here!'
          );

          console.log('[webhook] ✅ Success message sent');
        } else {
          const anyCode = await WhatsAppLinkCode.findOne({ code });
          if (anyCode) {
            console.log('[webhook] Found code but invalid:', {
              code: anyCode.code,
              used: anyCode.used,
              expiresAt: anyCode.expiresAt,
              expired: anyCode.expiresAt < new Date(),
            });
          }

          await sendWhatsApp(
            from,
            '❌ Invalid or expired code. Generate a new one at notenexus.vercel.app/dashboard'
          );
        }
      } else {
        await sendWhatsApp(
          from,
          '👋 Not linked yet.\n\nGo to notenexus.vercel.app/dashboard → WhatsApp Bot → Get Link Code\n\nThen reply: *link YOUR_CODE*'
        );
      }
      return;
    }

    // Media handling
    const numMedia = parseInt(NumMedia || '0', 10);

    if (numMedia > 0 && MediaUrl0) {
      const contentType = (MediaContentType0 || '').toLowerCase();
      console.log('[webhook] 📎 Media received, type:', contentType);

      if (contentType === 'application/pdf') {
        return handleIncomingPDF(session, MediaUrl0, contentType, from);
      }

      if (contentType.startsWith('image/')) {
        return handleIncomingImage(session, MediaUrl0, from);
      }

      return sendWhatsApp(from, `⚠️ Unsupported file type: ${contentType}\n\nSupported: PDF, JPG, PNG`);
    }

    // Text commands
    console.log('[webhook] 💬 Processing text command:', text);

    // "unlink" command
    if (text === 'unlink' || text === 'disconnect') {
      await WhatsAppSession.updateOne({ phone: from }, { isActive: false });
      await sendWhatsApp(
        from,
        '✅ Account unlinked.\n\nTo link again, generate a new code at notenexus.vercel.app/dashboard'
      );
      console.log('[webhook] ✅ Session unlinked');
      return;
    }

    // "images <N>"
    if (text.startsWith('images ')) {
      const idx = parseInt(text.replace('images ', '').trim(), 10);

      if (isNaN(idx) || idx < 1) {
        return sendWhatsApp(from, '❓ Usage: *images 2* (to get images from your 2nd note)');
      }

      const notes = await Note.find({ userId: session.userId }).sort({ createdAt: -1 }).limit(idx);
      const note = notes[idx - 1];

      if (!note) {
        return sendWhatsApp(from, `❌ You don't have a note #${idx}.`);
      }

      const imgs = note.extractedImages || [];

      if (!imgs.length) {
        return sendWhatsApp(
          from,
          `📄 *${note.title}* has no extracted images.\n\nOnly PDF notes contain images.`
        );
      }

      await sendWhatsApp(from, `🖼️ *${note.title}* — ${imgs.length} images extracted. Sending page 1:`);
      await sendWhatsAppMedia(from, `Page 1/${imgs.length}`, imgs[0]);

      if (imgs.length > 1) {
        await sendWhatsApp(
          from,
          `Send *images ${idx} 2* for page 2, etc.\n\nOr view all at notenexus.vercel.app`
        );
      }
      return;
    }

    // "images <N> <page>"
    if (/^images \d+ \d+$/.test(text)) {
      const [, noteIdx, pageIdx] = text.match(/^images (\d+) (\d+)$/);
      const notes = await Note.find({ userId: session.userId })
        .sort({ createdAt: -1 })
        .limit(parseInt(noteIdx));
      const note = notes[parseInt(noteIdx) - 1];
      const imgs = note?.extractedImages || [];
      const page = parseInt(pageIdx) - 1;

      if (!imgs[page]) {
        return sendWhatsApp(from, `❌ Page ${pageIdx} doesn't exist (only ${imgs.length} pages).`);
      }

      await sendWhatsAppMedia(from, `Page ${pageIdx}/${imgs.length} — *${note.title}*`, imgs[page]);
      return;
    }

    // "notes"
    if (text === 'notes' || text === 'my notes') {
      const notes = await Note.find({ userId: session.userId })
        .sort({ createdAt: -1 })
        .limit(20)
        .select('-content');
      return sendWhatsApp(from, formatNotesList(notes));
    }

    // Number
    const noteNum = parseInt(text, 10);
    if (!isNaN(noteNum) && noteNum >= 1 && noteNum <= 20) {
      const notes = await Note.find({ userId: session.userId }).sort({ createdAt: -1 }).limit(noteNum);
      const note = notes[noteNum - 1];

      if (!note) {
        return sendWhatsApp(from, `❌ You don't have a note #${noteNum}.`);
      }

      return sendWhatsApp(from, formatNoteDetail(note));
    }

    // "help"
    if (text === 'help' || text === 'commands') {
      return sendWhatsApp(
        from,
        `📖 *NoteNexus Commands*\n\n📚 *notes* — list your notes\n🔢 *1, 2, 3...* — read a note\n🖼️ *images <N>* — get images from note N\n🖼️ *images <N> <page>* — specific page\n🔗 *unlink* — disconnect this WhatsApp\n\n📤 *Send a PDF* — auto-extract text + images\n📷 *Send an image/photo* — OCR text extraction\n\n🌐 Full app: notenexus.vercel.app`
      );
    }

    // AI response
    console.log('[webhook] 🤖 Generating AI response...');
    const recentNotes = await Note.find({ userId: session.userId })
      .sort({ createdAt: -1 })
      .limit(5)
      .select('title subject content');

    const context = recentNotes.map((n) => `${n.title}: ${n.content.slice(0, 300)}`).join('\n---\n');

    const aiReply = await askGroq(
      `You are NoteNexus AI assistant. Based on the user's study notes below, answer their question concisely.\n\nNotes:\n${context}\n\nQuestion: ${Body}`
    );

    await sendWhatsApp(from, `🤖 ${aiReply}\n\n_(based on your notes)_`);
    console.log('[webhook] ✅ AI response sent');

  } catch (err) {
    console.error('[webhook] ❌ ERROR:', err.message);
    console.error('[webhook] Stack:', err.stack);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// REST ENDPOINTS (for dashboard UI)
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/debug', auth, async (req, res) => {
  try {
    res.json({
      message: 'Auth working',
      user: {
        _id: req.user._id,
        email: req.user.email,
      },
      env: {
        hasTwilioSid: !!process.env.TWILIO_ACCOUNT_SID,
        hasTwilioToken: !!process.env.TWILIO_AUTH_TOKEN,
        hasTwilioNumber: !!process.env.TWILIO_WHATSAPP_NUMBER,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function handleGenerateCode(req, res) {
  try {
    console.log('[generateCode] Request from user:', req.user._id.toString(), req.user.email);

    const code = crypto.randomBytes(3).toString('hex').toUpperCase();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    const deleted = await WhatsAppLinkCode.deleteMany({
      userId: req.user._id,
      used: false,
    });
    console.log('[generateCode] Deleted old codes:', deleted.deletedCount);

    const linkDoc = await WhatsAppLinkCode.create({
      userId: req.user._id,
      code,
      expiresAt,
      used: false,
    });

    console.log('[generateCode] ✅ Code created:', code, 'expires:', expiresAt);

    res.json({
      code,
      expiresAt,
      message: 'Code generated successfully',
    });
  } catch (err) {
    console.error('[generateCode] ❌ Error:', err.message);
    console.error('[generateCode] Stack:', err.stack);

    res.status(500).json({
      message: 'Failed to generate code',
      error: process.env.NODE_ENV === 'development' ? err.message : 'Server error',
    });
  }
}

router.post('/generate-code', auth, handleGenerateCode);
router.post('/generate-link-code', auth, handleGenerateCode);

router.get('/status', auth, async (req, res) => {
  try {
    const configured = !!(
      process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_AUTH_TOKEN &&
      process.env.TWILIO_WHATSAPP_NUMBER
    );

    const session = await WhatsAppSession.findOne({
      userId: req.user._id,
      isActive: true,
    });

    res.json({
      configured,
      linked: !!session,
      phone: session?.phone || null,
      webhookUrl: configured
        ? `${process.env.BACKEND_URL || 'https://your-backend.com'}/api/whatsapp/webhook`
        : null,
    });
  } catch (err) {
    console.error('[status] Error:', err.message);
    res.status(500).json({ message: 'Failed to get status' });
  }
});

router.get('/link-status', auth, async (req, res) => {
  try {
    const session = await WhatsAppSession.findOne({
      userId: req.user._id,
      isActive: true,
    });

    res.json({
      linked: !!session,
      phone: session?.phone || null,
    });
  } catch (err) {
    console.error('[link-status] Error:', err.message);
    res.status(500).json({ message: 'Failed to get link status' });
  }
});

router.delete('/unlink', auth, async (req, res) => {
  try {
    const result = await WhatsAppSession.updateMany(
      { userId: req.user._id },
      { isActive: false }
    );

    console.log('[unlink] Deactivated sessions:', result.modifiedCount);

    res.json({ success: true });
  } catch (err) {
    console.error('[unlink] Error:', err.message);
    res.status(500).json({ message: 'Failed to unlink' });
  }
});

module.exports = router;
