/**
 * ingestionService.js  —  NoteNexus
 *
 * PDF OCR strategy (100% reliable, no Cloudinary dependency):
 *
 *  1. pdf-parse  → fast embedded-text extraction (text-based PDFs)
 *  2. If <50 chars returned, PDF is image-based (scanned).
 *     → Render every page locally using pdfjs-dist + canvas
 *     → Send each rendered JPEG directly to Groq Vision OCR
 *     → No Cloudinary pg_N trick — works on all plans / environments
 *
 * Requires:  npm install canvas
 * (Cairo is pre-installed on Render's Node runtime — no Dockerfile needed)
 */

const pdfParse   = require('pdf-parse');
const https      = require('https');
const http       = require('http');
const { URL }    = require('url');
const FormData   = require('form-data');
const cloudinary = require('../config/cloudinary').cloudinary;

// ── Fetch file buffer from any URL ────────────────────────────────────────────
const fetchBuffer = (urlStr) =>
  new Promise((resolve, reject) => {
    try {
      const parsed  = new URL(urlStr);
      const lib     = parsed.protocol === 'https:' ? https : http;
      const request = lib.get(urlStr, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return fetchBuffer(res.headers.location).then(resolve).catch(reject);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} fetching ${urlStr}`));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          if (buffer.length === 0) return reject(new Error('Downloaded file is empty'));
          resolve(buffer);
        });
        res.on('error', reject);
      });
      request.on('error', reject);
      request.setTimeout(60000, () => {
        request.destroy();
        reject(new Error('Request timeout'));
      });
    } catch (e) { reject(e); }
  });

// ── Groq Vision API ───────────────────────────────────────────────────────────
const groqVision = (base64Data, mimeType, prompt) =>
  new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Data}` } },
          { type: 'text', text: prompt }
        ]
      }],
      max_tokens: 4096,
      temperature: 0.1
    });

    const options = {
      hostname: 'api.groq.com',
      path: '/openai/v1/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message));
          resolve(parsed.choices?.[0]?.message?.content?.trim() || '');
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => {
      req.destroy();
      reject(new Error('Groq vision timeout'));
    });
    req.write(body);
    req.end();
  });

// ── Groq Whisper API ──────────────────────────────────────────────────────────
const groqWhisper = (audioBuffer, filename) =>
  new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('file', audioBuffer, {
      filename:    filename || 'audio.mp3',
      contentType: 'audio/mpeg'
    });
    form.append('model', 'whisper-large-v3');
    form.append('response_format', 'text');

    const options = {
      hostname: 'api.groq.com',
      path: '/openai/v1/audio/transcriptions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        ...form.getHeaders()
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try {
          if (data && data.trim().length > 0 && !data.includes('"error"')) {
            return resolve(data.trim());
          }
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message));
          resolve(parsed.text || '');
        } catch (e) {
          if (data && data.trim().length > 5) resolve(data.trim());
          else reject(new Error('Empty transcription response'));
        }
      });
    });
    req.on('error', reject);
    form.pipe(req);
  });

// ── Extract text from PDF ─────────────────────────────────────────────────────
// Step 1: pdf-parse for text-based PDFs (instant).
// Step 2: pdfjs-dist + canvas renders each page as JPEG locally, then
//         Groq Vision OCR — zero dependency on Cloudinary plan features.
const extractFromPDF = async (pdfUrl) => {
  // ── Step 1: embedded text ─────────────────────────────────────────────────
  const buffer = await fetchBuffer(pdfUrl);
  const data   = await pdfParse(buffer);
  const text   = (data.text || '').trim();

  if (text.length > 50) {
    console.log(`[extractFromPDF] Embedded text found (${text.length} chars).`);
    return text;
  }

  // ── Step 2: render pages locally and OCR ─────────────────────────────────
  console.log('[extractFromPDF] No embedded text — rendering pages locally for OCR...');

  // Load pdfjs-dist (supports both CJS and ESM builds)
  let pdfjsLib;
  try {
    pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
  } catch {
    pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  }

  const { createCanvas } = require('canvas');

  const uint8Array = new Uint8Array(buffer);
  const pdfDoc     = await pdfjsLib.getDocument({
    data:            uint8Array,
    useSystemFonts:  true,   // avoids font-worker errors in Node
    disableFontFace: true,
  }).promise;

  const pageCount = Math.min(pdfDoc.numPages, 20);
  console.log(`[extractFromPDF] ${pdfDoc.numPages} page(s) in PDF — processing ${pageCount}.`);

  const pageTexts = [];

  for (let pg = 1; pg <= pageCount; pg++) {
    try {
      const page     = await pdfDoc.getPage(pg);
      const viewport = page.getViewport({ scale: 2.0 }); // ~150 dpi — good OCR quality

      const canvas  = createCanvas(viewport.width, viewport.height);
      const context = canvas.getContext('2d');

      await page.render({ canvasContext: context, viewport }).promise;

      // Convert to JPEG buffer — goes straight to Groq, no upload needed
      const jpegBuffer = canvas.toBuffer('image/jpeg', { quality: 0.92 });
      const base64     = jpegBuffer.toString('base64');

      console.log(`[extractFromPDF] Page ${pg}/${pageCount} rendered (${jpegBuffer.length} bytes) — OCR in progress...`);

      const pageText = await groqVision(
        base64,
        'image/jpeg',
        'Extract ALL text from this page image. Preserve layout and formatting. Return only the text, nothing else.'
      );

      if (pageText && pageText.trim().length > 0) {
        pageTexts.push(`--- Page ${pg} ---\n${pageText.trim()}`);
        console.log(`[extractFromPDF] Page ${pg} done (${pageText.trim().length} chars).`);
      } else {
        console.warn(`[extractFromPDF] Page ${pg} returned empty OCR result.`);
      }

      page.cleanup(); // free canvas memory between pages
    } catch (err) {
      console.warn(`[extractFromPDF] Page ${pg} failed:`, err.message);
      // Continue — one bad page must not abort the whole document
    }
  }

  if (pageTexts.length === 0) {
    throw new Error('Could not extract text from source — vision OCR returned nothing.');
  }

  return pageTexts.join('\n\n');
};

// ── Extract text from image ───────────────────────────────────────────────────
const extractFromImage = async (imageUrl) => {
  const buffer = await fetchBuffer(imageUrl);
  const base64 = buffer.toString('base64');
  const ext    = imageUrl.split('.').pop().toLowerCase().split('?')[0];
  const mime   = ext === 'png' ? 'image/png' : 'image/jpeg';
  return groqVision(
    base64,
    mime,
    'Extract ALL text from this image. Return only the extracted text, preserving layout. If no text, describe the image in detail for study notes.'
  );
};

// ── Extract from voice ────────────────────────────────────────────────────────
const extractFromVoice = async (audioUrl) => {
  const buffer = await fetchBuffer(audioUrl);
  return groqWhisper(buffer, audioUrl.split('/').pop() || 'audio.mp3');
};

// ── Extract from YouTube ──────────────────────────────────────────────────────
const extractFromYouTube = async (youtubeUrl) => {
  const { YoutubeTranscript } = require('youtube-transcript');

  const idMatch = youtubeUrl.match(
    /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/
  );
  if (!idMatch) throw new Error('Invalid YouTube URL');

  const videoId    = idMatch[1];
  const transcript = await YoutubeTranscript.fetchTranscript(videoId);

  if (!transcript || transcript.length === 0) {
    throw new Error('No transcript available for this YouTube video');
  }

  return transcript.map((item) => item.text).join(' ');
};

// ────────────────────────────────────────────────────────────────────────────
// extractImagesFromPDF
//
//  A) Local page renders via pdfjs-dist + canvas → upload to Cloudinary
//  B) Embedded image extraction via pdfjs-dist operator list
//
//  Returns: { pageImages: string[], embeddedImages: string[] }
// ────────────────────────────────────────────────────────────────────────────
const extractImagesFromPDF = async (pdfUrl, options = {}) => {
  const {
    maxPages        = 20,
    extractEmbedded = true,
  } = options;

  const results = {
    pageImages:     [],
    embeddedImages: [],
  };

  // Load pdfjs-dist once for both A and B
  let pdfjsLib;
  try {
    pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
  } catch {
    pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  }

  const buffer     = await fetchBuffer(pdfUrl);
  const uint8Array = new Uint8Array(buffer);
  const pdfDoc     = await pdfjsLib.getDocument({
    data:            uint8Array,
    useSystemFonts:  true,
    disableFontFace: true,
  }).promise;

  const pageCount = Math.min(pdfDoc.numPages, maxPages);

  // ── A) Render each page and upload to Cloudinary ──────────────────────────
  try {
    const { createCanvas } = require('canvas');

    for (let pg = 1; pg <= pageCount; pg++) {
      try {
        const page     = await pdfDoc.getPage(pg);
        const viewport = page.getViewport({ scale: 1.5 });
        const canvas   = createCanvas(viewport.width, viewport.height);
        const context  = canvas.getContext('2d');

        await page.render({ canvasContext: context, viewport }).promise;

        const jpegBuffer = canvas.toBuffer('image/jpeg', { quality: 0.85 });

        const uploadResult = await new Promise((resolve, reject) => {
          const { Readable } = require('stream');
          const stream = cloudinary.uploader.upload_stream(
            { resource_type: 'image', format: 'jpg', folder: 'notenexus/pdf-pages' },
            (err, result) => { if (err) reject(err); else resolve(result); }
          );
          Readable.from(jpegBuffer).pipe(stream);
        });

        results.pageImages.push(uploadResult.secure_url);
        page.cleanup();
      } catch (err) {
        console.warn(`[extractImagesFromPDF] Page ${pg} render failed:`, err.message);
      }
    }
    console.log(`[extractImagesFromPDF] ${results.pageImages.length} page images uploaded.`);
  } catch (err) {
    console.warn('[extractImagesFromPDF] Page render stage failed:', err.message);
  }

  // ── B) Embedded image extraction ──────────────────────────────────────────
  if (extractEmbedded) {
    try {
      let imageIndex = 0;

      for (let pg = 1; pg <= pageCount; pg++) {
        const page     = await pdfDoc.getPage(pg);
        const opList   = await page.getOperatorList();
        const imgNames = new Set();

        opList.fnArray.forEach((fn, i) => {
          if (fn === 85 || fn === 83) { // paintImageXObject / paintInlineImageXObject
            imgNames.add(opList.argsArray[i]?.[0]);
          }
        });

        for (const name of imgNames) {
          try {
            const img = await page.objs.get(name);
            if (!img || !img.data || !img.width || !img.height) continue;

            const pngBuffer = await rgbaToPng(img.data, img.width, img.height);

            const uploadResult = await new Promise((resolve, reject) => {
              const { Readable } = require('stream');
              const stream = cloudinary.uploader.upload_stream(
                { resource_type: 'image', format: 'png', folder: 'notenexus/pdf-embedded' },
                (err, result) => { if (err) reject(err); else resolve(result); }
              );
              Readable.from(pngBuffer).pipe(stream);
            });

            results.embeddedImages.push(uploadResult.secure_url);
            imageIndex++;
          } catch (imgErr) {
            console.warn(`[extractImagesFromPDF] Skipping image ${name} pg ${pg}:`, imgErr.message);
          }
        }
      }

      console.log(`[extractImagesFromPDF] ${imageIndex} embedded images extracted.`);
    } catch (err) {
      console.warn('[extractImagesFromPDF] Embedded extraction failed:', err.message);
    }
  }

  return results;
};

// ── Minimal RGBA → PNG encoder (no extra deps) ────────────────────────────────
const rgbaToPng = (rgba, width, height) =>
  new Promise((resolve) => {
    const zlib = require('zlib');

    const sig  = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width,  0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

    const makeChunk = (type, data) => {
      const typeBuf = Buffer.from(type, 'ascii');
      const len     = Buffer.alloc(4);
      len.writeUInt32BE(data.length, 0);
      const crcBuf  = Buffer.alloc(4);
      try {
        const crc = require('crc-32').buf(Buffer.concat([typeBuf, data])) >>> 0;
        crcBuf.writeUInt32BE(crc, 0);
      } catch (_) { /* zero CRC fallback — Cloudinary still decodes it */ }
      return Buffer.concat([len, typeBuf, data, crcBuf]);
    };

    const raw = Buffer.alloc(height * (1 + width * 3));
    for (let y = 0; y < height; y++) {
      raw[y * (1 + width * 3)] = 0;
      for (let x = 0; x < width; x++) {
        const si = (y * width + x) * 4;
        const di = y * (1 + width * 3) + 1 + x * 3;
        raw[di] = rgba[si]; raw[di + 1] = rgba[si + 1]; raw[di + 2] = rgba[si + 2];
      }
    }

    zlib.deflate(raw, (err, compressed) => {
      if (err) { resolve(Buffer.alloc(0)); return; }
      resolve(Buffer.concat([
        sig,
        makeChunk('IHDR', ihdr),
        makeChunk('IDAT', compressed),
        makeChunk('IEND', Buffer.alloc(0)),
      ]));
    });
  });

module.exports = {
  extractFromPDF,
  extractFromImage,
  extractFromVoice,
  extractFromYouTube,
  extractImagesFromPDF,
};
