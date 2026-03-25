/**
 * ingestionService.js  —  NoteNexus
 *
 * PDF OCR strategy (no Cloudinary pg_N dependency for old raw uploads):
 *
 *  1. pdf-parse  → fast embedded-text extraction (text-based PDFs)
 *  2. If <50 chars returned, PDF is image-based (scanned).
 *     → Determine a valid Cloudinary *image* URL for pg_N rendering:
 *         a) New uploads: resource_type='image' → URL already has /image/upload/
 *         b) Old uploads: resource_type='raw'   → URL has /raw/upload/
 *            Re-upload buffer once as resource_type='image', use that URL.
 *         c) Non-Cloudinary URL: same re-upload path as (b).
 *     → Render each page as JPEG via pg_N, fetch it, send to Groq Vision OCR.
 *     → Concatenate all pages, return full text.
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
      const parsed = new URL(urlStr);
      const lib    = parsed.protocol === 'https:' ? https : http;
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

// ── Upload a buffer to Cloudinary as resource_type='image' ───────────────────
// Returns the secure_url of the uploaded asset.
const uploadBufferAsImage = (buffer, folder = 'notenexus/pdfs') =>
  new Promise((resolve, reject) => {
    const { Readable } = require('stream');
    const stream = cloudinary.uploader.upload_stream(
      { resource_type: 'image', format: 'pdf', folder },
      (err, result) => { if (err) reject(err); else resolve(result.secure_url); }
    );
    Readable.from(buffer).pipe(stream);
  });

// ── Derive a Cloudinary *image* base URL suitable for pg_N ───────────────────
// Handles three cases:
//   1. Already an image URL  (/image/upload/)  → use as-is
//   2. Raw URL               (/raw/upload/)    → re-upload buffer as image
//   3. Non-Cloudinary URL                      → re-upload buffer as image
const getCloudinaryImageUrl = async (pdfUrl, buffer) => {
  if (pdfUrl.includes('res.cloudinary.com')) {
    if (pdfUrl.includes('/image/upload/')) {
      // New-style upload — pg_N ready
      return pdfUrl;
    }
    if (pdfUrl.includes('/raw/upload/')) {
      // Old-style upload — re-upload once as image type
      console.log('[getCloudinaryImageUrl] Detected raw URL — re-uploading as image type...');
      return uploadBufferAsImage(buffer);
    }
  }
  // Non-Cloudinary URL
  console.log('[getCloudinaryImageUrl] Non-Cloudinary URL — uploading buffer...');
  return uploadBufferAsImage(buffer);
};

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
const extractFromPDF = async (pdfUrl) => {
  // ── Step 1: try embedded text (instant, free) ─────────────────────────────
  const buffer = await fetchBuffer(pdfUrl);
  const data   = await pdfParse(buffer);
  const text   = (data.text || '').trim();

  if (text.length > 50) {
    console.log(`[extractFromPDF] Embedded text found (${text.length} chars).`);
    return text;
  }

  // ── Step 2: scanned/image PDF — OCR every page via Groq Vision ────────────
  console.log('[extractFromPDF] No embedded text — starting vision OCR...');

  const pageCount       = Math.min(data.numpages || 1, 20);
  const cloudinaryImgUrl = await getCloudinaryImageUrl(pdfUrl, buffer);

  console.log(`[extractFromPDF] Using image base URL: ${cloudinaryImgUrl}`);
  console.log(`[extractFromPDF] Pages to OCR: ${pageCount}`);

  const pageTexts = [];

  for (let pg = 1; pg <= pageCount; pg++) {
    try {
      // Build the pg_N transformation URL
      const imageUrl = cloudinaryImgUrl.replace(
        '/upload/',
        `/upload/pg_${pg},f_jpg,w_1400,q_90/`
      );

      console.log(`[extractFromPDF] Fetching page ${pg}: ${imageUrl}`);
      const imgBuffer = await fetchBuffer(imageUrl);
      console.log(`[extractFromPDF] Page ${pg} image size: ${imgBuffer.length} bytes`);

      // Cloudinary returns a small error image for out-of-range pages
      if (imgBuffer.length < 5000) {
        console.log(`[extractFromPDF] Page ${pg} too small (${imgBuffer.length}B) — stopping early.`);
        break;
      }

      const base64    = imgBuffer.toString('base64');
      const pageText  = await groqVision(
        base64,
        'image/jpeg',
        'Extract ALL text from this page image. Preserve layout and formatting. Return only the text, nothing else.'
      );

      if (pageText && pageText.trim().length > 0) {
        pageTexts.push(`--- Page ${pg} ---\n${pageText.trim()}`);
        console.log(`[extractFromPDF] Page ${pg} OCR complete (${pageText.trim().length} chars).`);
      } else {
        console.warn(`[extractFromPDF] Page ${pg} returned empty OCR result.`);
      }
    } catch (err) {
      console.warn(`[extractFromPDF] OCR failed for page ${pg}:`, err.message);
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

  // Extract video ID from various YouTube URL formats
  const idMatch = youtubeUrl.match(
    /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/
  );
  if (!idMatch) throw new Error('Invalid YouTube URL');

  const videoId = idMatch[1];
  const transcript = await YoutubeTranscript.fetchTranscript(videoId);

  if (!transcript || transcript.length === 0) {
    throw new Error('No transcript available for this YouTube video');
  }

  return transcript.map((item) => item.text).join(' ');
};

// ────────────────────────────────────────────────────────────────────────────
// extractImagesFromPDF
//
//  A) Cloudinary pg_N page renders — one JPEG URL per page
//  B) pdfjs-dist embedded image extraction — raw images inside the PDF
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

  // ── A) Page renders ────────────────────────────────────────────────────────
  try {
    const buffer          = await fetchBuffer(pdfUrl);
    const parsed          = await pdfParse(buffer);
    const pageCount       = Math.min(parsed.numpages || 1, maxPages);
    const cloudinaryImgUrl = await getCloudinaryImageUrl(pdfUrl, buffer);

    for (let pg = 1; pg <= pageCount; pg++) {
      const pageUrl = cloudinaryImgUrl.replace(
        '/upload/',
        `/upload/pg_${pg},f_jpg,w_1200,q_85/`
      );
      results.pageImages.push(pageUrl);
    }
    console.log(`[extractImagesFromPDF] ${pageCount} page image URLs generated.`);
  } catch (err) {
    console.warn('[extractImagesFromPDF] Page render failed:', err.message);
  }

  // ── B) Embedded image extraction via pdfjs-dist ───────────────────────────
  if (extractEmbedded) {
    try {
      const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs').catch(() =>
        require('pdfjs-dist/legacy/build/pdf.js')
      );

      const buffer     = await fetchBuffer(pdfUrl);
      const uint8Array = new Uint8Array(buffer);
      const pdfDoc     = await pdfjsLib.getDocument({ data: uint8Array }).promise;
      const pageCount  = Math.min(pdfDoc.numPages, maxPages);

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
            if (!img || !img.data) continue;

            const { width, height, data: rgba } = img;
            if (!width || !height) continue;

            const pngBuffer = await rgbaToPng(rgba, width, height);

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
            console.warn(
              `[extractImagesFromPDF] Skipping image ${name} on page ${pg}:`,
              imgErr.message
            );
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
      } catch (_) { /* zero CRC fallback */ }
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
