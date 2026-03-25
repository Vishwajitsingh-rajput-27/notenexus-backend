// routes/whatsapp.js  —  NoteNexus
//
// CHANGES vs original:
//   • handleIncomingPDF()  — when a WhatsApp user sends a PDF, we download,
//     extract text + images, save a Note, then reply with a summary and
//     the first extracted page image back to the user.
//   • handleIncomingImage() — when user sends an image, extract text via Groq
//     Vision and save as an image Note.
//   • Webhook now detects MediaContentType and routes accordingly.
//   • WhatsApp users can type "images <N>" to get page images of their Nth note.
//
// Everything else (sessions, link codes, existing commands) is UNCHANGED.

const express  = require('express');
const router   = express.Router();
const https    = require('https');
const crypto   = require('crypto');
const auth     = require('../middleware/auth');
const { WhatsAppSession, WhatsAppLinkCode } = require('../models/WhatsAppSession');
const Note      = require('../models/Note');
const SavedItem = require('../models/SavedItem');
const Reminder  = require('../models/Reminder');
const {
  extractFromPDF,
  extractFromImage,
  extractImagesFromPDF,
} = require('../services/ingestionService');
const { detectSubjectChapter, translateToEnglish } = require('../services/aiService');
const { storeEmbedding } = require('../services/vectorService');
const { v4: uuidv4 }   = require('uuid');
const { upload, cloudinary } = require('../config/cloudinary');

// ─── Groq AI helper ───────────────────────────────────────────────────────────
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
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message));
          if (!parsed.choices?.[0]?.message?.content) return reject(new Error('Empty response from Groq'));
          resolve(parsed.choices[0].message.content);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(25000, () => { req.destroy(); reject(new Error('Groq timeout')); });
    req.write(body);
    req.end();
  });
}

// ─── Twilio helper ────────────────────────────────────────────────────────────
function getTwilioClient() {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN)
    throw new Error('Twilio env vars not set');
  return require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

async function sendWhatsApp(to, body) {
  const client = getTwilioClient();
  await client.messages.create({
    from: process.env.TWILIO_WHATSAPP_NUMBER,
    to,
    body: body.slice(0, 1600),
  });
}

// Send a WhatsApp message that includes a media image URL
async function sendWhatsAppMedia(to, body, mediaUrl) {
  const client = getTwilioClient();
  await client.messages.create({
    from: process.env.TWILIO_WHATSAPP_NUMBER,
    to,
    body: body.slice(0, 1600),
    mediaUrl: [mediaUrl],
  });
}

// ─── Format helpers (unchanged from original) ─────────────────────────────────
function formatNotesList(notes) {
  if (!notes.length) return '📭 You have no notes yet.\n\nUpload notes at notenexus.vercel.app';
  const lines = notes.slice(0, 10).map((n, i) => {
    const date = new Date(n.createdAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
    const imgBadge = n.extractedImages?.length ? ` 🖼️×${n.extractedImages.length}` : '';
    return `${i + 1}. 📄 *${n.title}*${imgBadge}\n   Subject: ${n.subject} | ${n.chapter}\n   Added: ${date}`;
  });
  const extra = notes.length > 10 ? `\n\n...and ${notes.length - 10} more notes.` : '';
  return `📚 *Your Notes* (${notes.length} total)\n\n${lines.join('\n\n')}${extra}\n\nType a number to read a note, or *images <N>* to see PDF images.`;
}

function formatNoteDetail(note) {
  const sourceIcon = { pdf: '📄', image: '🖼️', youtube: '🎥', voice: '🎙️', whatsapp: '💬', text: '📝' };
  const icon = sourceIcon[note.sourceType] || '📄';
  const lines = [];
  lines.push(`${icon} *${note.title}*`);
  lines.push(`📚 Subject: ${note.subject} | ${note.chapter}`);
  if (note.extractedImages?.length)
    lines.push(`🖼️ *${note.extractedImages.length} images extracted* — type *images <N>* to view`);
  if (note.keywords?.length) lines.push(`🏷️ Keywords: ${note.keywords.join(', ')}`);
  lines.push('');
  if (note.content) {
    lines.push(note.content.slice(0, 800));
    if (note.content.length > 800) lines.push('\n_(content truncated — open app for full note)_');
  }
  return lines.join('\n');
}

// ─── NEW: Handle incoming PDF from WhatsApp ───────────────────────────────────
async function handleIncomingPDF(session, mediaUrl, mediaContentType, from) {
  try {
    await sendWhatsApp(from, '📄 PDF received! Processing text and extracting images... ⏳');

    // Download and upload to Cloudinary so we have a permanent URL
    const https = require('https');
    const http  = require('http');
    const { URL } = require('url');

    const fetchBuffer = (urlStr) => new Promise((resolve, reject) => {
      const parsed = new URL(urlStr);
      const lib = parsed.protocol === 'https:' ? https : http;
      // Twilio media URLs require auth
      const authHeader = 'Basic ' + Buffer.from(
        `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
      ).toString('base64');
      const options = { hostname: parsed.hostname, path: parsed.pathname + parsed.search, headers: { Authorization: authHeader } };
      const req = lib.get(options, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      });
      req.on('error', reject);
    });

    const pdfBuffer = await fetchBuffer(mediaUrl);

    // Upload PDF to Cloudinary
    const uploadedPdf = await new Promise((resolve, reject) => {
      const { Readable } = require('stream');
      const stream = cloudinary.uploader.upload_stream(
        { resource_type: 'raw', format: 'pdf', folder: 'notenexus/whatsapp-pdfs' },
        (err, result) => { if (err) reject(err); else resolve(result); }
      );
      Readable.from(pdfBuffer).pipe(stream);
    });

    const pdfCloudinaryUrl = uploadedPdf.secure_url;

    // Extract text + images in parallel
    const [extractedText, imgResult] = await Promise.all([
      extractFromPDF(pdfCloudinaryUrl),
      extractImagesFromPDF(pdfCloudinaryUrl, { maxPages: 10, extractEmbedded: true }),
    ]);

    if (!extractedText?.trim()) {
      return sendWhatsApp(from, '⚠️ Could not extract text from that PDF. Please try a text-based PDF.');
    }

    const englishText = await translateToEnglish(extractedText);
    const meta        = await detectSubjectChapter(englishText);
    const autoTitle   = `${meta.subject} — ${meta.chapter}`;
    const noteId      = uuidv4();

    const allImages = [...imgResult.pageImages, ...imgResult.embeddedImages];

    const note = await Note.create({
      userId:          session.userId,
      title:           autoTitle,
      content:         englishText,
      sourceType:      'whatsapp',
      fileUrl:         pdfCloudinaryUrl,
      subject:         meta.subject,
      chapter:         meta.chapter,
      keywords:        meta.keywords || [],
      pineconeId:      noteId,
      extractedImages: allImages,
    });

    await storeEmbedding(noteId, englishText, {
      userId:    session.userId.toString(),
      noteId:    note._id.toString(),
      subject:   meta.subject,
      chapter:   meta.chapter,
      sourceType: 'whatsapp',
      fileUrl:   pdfCloudinaryUrl,
      title:     autoTitle,
    });

    // Reply with summary
    const summary = `✅ *PDF Saved!*\n\n📚 *${autoTitle}*\nSubject: ${meta.subject}\nChapter: ${meta.chapter}\nKeywords: ${(meta.keywords || []).slice(0, 5).join(', ')}\n🖼️ ${allImages.length} images extracted\n📝 ${englishText.split(/\s+/).length} words\n\n${englishText.slice(0, 400)}${englishText.length > 400 ? '...' : ''}`;

    await sendWhatsApp(from, summary);

    // Send the first page image back if available
    if (allImages.length > 0) {
      await sendWhatsAppMedia(from, `🖼️ Page 1 of your PDF (${allImages.length} total pages extracted):`, allImages[0]);
    }

  } catch (err) {
    console.error('[handleIncomingPDF]', err);
    await sendWhatsApp(from, '❌ Failed to process your PDF. Please try again or upload at notenexus.vercel.app');
  }
}

// ─── NEW: Handle incoming image from WhatsApp ─────────────────────────────────
async function handleIncomingImage(session, mediaUrl, from) {
  try {
    await sendWhatsApp(from, '🖼️ Image received! Extracting text... ⏳');

    const extractedText = await extractFromImage(mediaUrl);
    if (!extractedText?.trim()) {
      return sendWhatsApp(from, '⚠️ Could not extract text from that image. Is it a clear photo of notes?');
    }

    const englishText = await translateToEnglish(extractedText);
    const meta        = await detectSubjectChapter(englishText);
    const autoTitle   = `${meta.subject} — ${meta.chapter}`;
    const noteId      = uuidv4();

    const note = await Note.create({
      userId:     session.userId,
      title:      autoTitle,
      content:    englishText,
      sourceType: 'whatsapp',
      fileUrl:    mediaUrl,
      subject:    meta.subject,
      chapter:    meta.chapter,
      keywords:   meta.keywords || [],
      pineconeId: noteId,
    });

    await storeEmbedding(noteId, englishText, {
      userId: session.userId.toString(), noteId: note._id.toString(),
      subject: meta.subject, chapter: meta.chapter,
      sourceType: 'whatsapp', fileUrl: mediaUrl, title: autoTitle,
    });

    await sendWhatsApp(from, `✅ *Image Note Saved!*\n\n📚 *${autoTitle}*\nSubject: ${meta.subject}\nChapter: ${meta.chapter}\n\n${englishText.slice(0, 500)}`);

  } catch (err) {
    console.error('[handleIncomingImage]', err);
    await sendWhatsApp(from, '❌ Failed to process your image. Please try again.');
  }
}

// ─── Webhook — Twilio sends ALL incoming WhatsApp messages here ───────────────
router.post('/webhook', async (req, res) => {
  res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');

  try {
    const {
      From,
      Body,
      NumMedia,
      MediaUrl0,
      MediaContentType0,
    } = req.body;

    const from = From;
    const text = (Body || '').trim().toLowerCase();

    // Find linked session
    const session = await WhatsAppSession.findOne({ phoneNumber: from, isActive: true });
    if (!session) {
      // Check for link code
      const parts = text.split(' ');
      if (parts[0] === 'link' && parts[1]) {
        const code    = parts[1].toUpperCase();
        const linkDoc = await WhatsAppLinkCode.findOne({ code, used: false, expiresAt: { $gt: new Date() } });
        if (linkDoc) {
          await WhatsAppSession.create({ userId: linkDoc.userId, phoneNumber: from, isActive: true });
          await WhatsAppLinkCode.updateOne({ _id: linkDoc._id }, { used: true });
          await sendWhatsApp(from, '✅ *NoteNexus linked!*\n\nCommands:\n• *notes* — list your notes\n• *help* — full command list\n\nYou can also *send a PDF* or *image* directly here!');
        } else {
          await sendWhatsApp(from, '❌ Invalid or expired code. Generate a new one at notenexus.vercel.app/dashboard');
        }
      } else {
        await sendWhatsApp(from, '👋 Not linked yet.\n\nGo to notenexus.vercel.app/dashboard → WhatsApp Bot → Get Link Code\n\nThen reply: *link YOUR_CODE*');
      }
      return;
    }

    // ── Media handling (PDF / Image) ─────────────────────────────────────────
    const numMedia = parseInt(NumMedia || '0', 10);
    if (numMedia > 0 && MediaUrl0) {
      const contentType = (MediaContentType0 || '').toLowerCase();

      if (contentType === 'application/pdf') {
        return handleIncomingPDF(session, MediaUrl0, contentType, from);
      }

      if (contentType.startsWith('image/')) {
        return handleIncomingImage(session, MediaUrl0, from);
      }

      return sendWhatsApp(from, `⚠️ Unsupported file type: ${contentType}\n\nSupported: PDF, JPG, PNG`);
    }

    // ── Text commands ─────────────────────────────────────────────────────────
    // "images <N>" — send page images of the Nth note
    if (text.startsWith('images ')) {
      const idx = parseInt(text.replace('images ', '').trim(), 10);
      if (isNaN(idx) || idx < 1) return sendWhatsApp(from, '❓ Usage: *images 2* (to get images from your 2nd note)');

      const notes = await Note.find({ userId: session.userId }).sort({ createdAt: -1 }).limit(idx);
      const note  = notes[idx - 1];
      if (!note) return sendWhatsApp(from, `❌ You don't have a note #${idx}.`);

      const imgs = note.extractedImages || [];
      if (!imgs.length) return sendWhatsApp(from, `📄 *${note.title}* has no extracted images.\n\nOnly PDF notes contain images.`);

      await sendWhatsApp(from, `🖼️ *${note.title}* — ${imgs.length} images extracted. Sending page 1:`);
      await sendWhatsAppMedia(from, `Page 1/${imgs.length}`, imgs[0]);
      if (imgs.length > 1) await sendWhatsApp(from, `Send *images ${idx} 2* for page 2, etc.\n\nOr view all at notenexus.vercel.app`);
      return;
    }

    // "images <N> <page>" — specific page
    if (/^images \d+ \d+$/.test(text)) {
      const [, noteIdx, pageIdx] = text.match(/^images (\d+) (\d+)$/);
      const notes = await Note.find({ userId: session.userId }).sort({ createdAt: -1 }).limit(parseInt(noteIdx));
      const note  = notes[parseInt(noteIdx) - 1];
      const imgs  = note?.extractedImages || [];
      const page  = parseInt(pageIdx) - 1;
      if (!imgs[page]) return sendWhatsApp(from, `❌ Page ${pageIdx} doesn't exist (only ${imgs.length} pages).`);
      await sendWhatsAppMedia(from, `Page ${pageIdx}/${imgs.length} — *${note.title}*`, imgs[page]);
      return;
    }

    // "notes" — list notes
    if (text === 'notes' || text === 'my notes') {
      const notes = await Note.find({ userId: session.userId }).sort({ createdAt: -1 }).limit(20).select('-content');
      return sendWhatsApp(from, formatNotesList(notes));
    }

    // Number — read that note
    const noteNum = parseInt(text, 10);
    if (!isNaN(noteNum) && noteNum >= 1 && noteNum <= 20) {
      const notes = await Note.find({ userId: session.userId }).sort({ createdAt: -1 }).limit(noteNum);
      const note  = notes[noteNum - 1];
      if (!note) return sendWhatsApp(from, `❌ You don't have a note #${noteNum}.`);
      return sendWhatsApp(from, formatNoteDetail(note));
    }

    // "help"
    if (text === 'help' || text === 'commands') {
      return sendWhatsApp(from, `📖 *NoteNexus Commands*\n\n📚 *notes* — list your notes\n🔢 *1, 2, 3...* — read a note\n🖼️ *images <N>* — get images from note N\n🖼️ *images <N> <page>* — specific page\n\n📤 *Send a PDF* — auto-extract text + images\n📷 *Send an image/photo* — OCR text extraction\n\n🌐 Full app: notenexus.vercel.app`);
    }

    // Default: AI answer based on notes
    const recentNotes = await Note.find({ userId: session.userId }).sort({ createdAt: -1 }).limit(5).select('title subject content');
    const context = recentNotes.map(n => `${n.title}: ${n.content.slice(0, 300)}`).join('\n---\n');
    const aiReply = await askGroq(`You are NoteNexus AI assistant. Based on the user's study notes below, answer their question concisely.\n\nNotes:\n${context}\n\nQuestion: ${Body}`);
    await sendWhatsApp(from, `🤖 ${aiReply}\n\n_(based on your notes)_`);

  } catch (err) {
    console.error('[WhatsApp webhook error]', err);
  }
});

// ─── REST endpoints (for dashboard UI) — unchanged ────────────────────────────

// POST /api/whatsapp/generate-code  (protected)
router.post('/generate-code', auth, async (req, res) => {
  try {
    const code      = crypto.randomBytes(3).toString('hex').toUpperCase();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 min
    await WhatsAppLinkCode.create({ userId: req.user._id, code, expiresAt });
    res.json({ code, expiresAt });
  } catch (err) {
    res.status(500).json({ message: 'Failed to generate code' });
  }
});

// GET /api/whatsapp/status  (protected)
router.get('/status', auth, async (req, res) => {
  const session = await WhatsAppSession.findOne({ userId: req.user._id, isActive: true });
  res.json({ linked: !!session, phoneNumber: session?.phoneNumber || null });
});

// DELETE /api/whatsapp/unlink  (protected)
router.delete('/unlink', auth, async (req, res) => {
  await WhatsAppSession.updateMany({ userId: req.user._id }, { isActive: false });
  res.json({ success: true });
});

module.exports = router;
