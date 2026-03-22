const pdfParse = require('pdf-parse');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const https = require('https');
const http = require('http');
const { URL } = require('url');

// ── Gemini client — always use gemini-1.5-flash (stable free tier) ────────────
const getModel = () => {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  return genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
};

// ── Fetch file buffer from any URL ────────────────────────────────────────────
const fetchBuffer = (urlStr) =>
  new Promise((resolve, reject) => {
    try {
      const parsed = new URL(urlStr);
      const lib = parsed.protocol === 'https:' ? https : http;

      const request = lib.get(urlStr, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return fetchBuffer(res.headers.location).then(resolve).catch(reject);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode}`));
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
      request.setTimeout(30000, () => {
        request.destroy();
        reject(new Error('Request timeout'));
      });
    } catch (e) {
      reject(e);
    }
  });

// ── Image → Text (Gemini Vision — replaces Tesseract) ────────────────────────
const extractFromImage = async (imageUrl) => {
  try {
    const model = getModel();
    const buffer = await fetchBuffer(imageUrl);
    const base64Image = buffer.toString('base64');

    // Detect mime type from URL extension
    const ext = imageUrl.split('.').pop().toLowerCase().split('?')[0];
    const mimeMap = {
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      gif: 'image/gif',
      webp: 'image/webp',
    };
    const mimeType = mimeMap[ext] || 'image/jpeg';

    const result = await model.generateContent([
      {
        inlineData: {
          mimeType,
          data: base64Image,
        },
      },
      'Extract and transcribe ALL text visible in this image. Return only the text content, preserving structure where possible.',
    ]);

    const text = result.response.text().trim();
    return text || 'No text found in image';
  } catch (err) {
    console.error('Image OCR error:', err.message);
    return 'Could not extract text from image. Please try a clearer image.';
  }
};

// ── PDF → Text (pdf-parse first, Gemini Vision fallback for scanned PDFs) ─────
const extractFromPDF = async (pdfUrl) => {
  try {
    const buffer = await fetchBuffer(pdfUrl);
    if (!buffer || buffer.length === 0) throw new Error('PDF file is empty');

    console.log('PDF buffer size:', buffer.length, 'bytes');

    const data = await pdfParse(buffer);
    const text = data.text.trim();

    if (text && text.length > 50) {
      return text;
    }

    // Fallback: treat as scanned PDF — send to Gemini Vision
    console.log('PDF has no selectable text — using Gemini Vision fallback');
    const base64PDF = buffer.toString('base64');
    const model = getModel();

    const result = await model.generateContent([
      {
        inlineData: {
          mimeType: 'application/pdf',
          data: base64PDF,
        },
      },
      'Extract and transcribe ALL text from this PDF document. Return only the text content.',
    ]);

    return result.response.text().trim() || 'Could not extract text from this PDF.';
  } catch (err) {
    console.error('PDF error:', err.message);
    throw new Error('Could not read PDF: ' + err.message);
  }
};

// ── YouTube → Transcript (fixed ES module bug — uses dynamic import) ──────────
const extractFromYouTube = async (url) => {
  try {
    const match = url.match(/(?:v=|youtu\.be\/|embed\/)([^&?/\s]{11})/);
    if (!match) throw new Error('Invalid YouTube URL');
    const videoId = match[1];

    // FIX: youtube-transcript is ESM — must use dynamic import() not require()
    try {
      const { YoutubeTranscript } = await import('youtube-transcript');
      const transcript = await YoutubeTranscript.fetchTranscript(videoId);
      if (transcript && transcript.length > 0) {
        return transcript.map((t) => t.text).join(' ').trim();
      }
    } catch (e) {
      console.error('youtube-transcript failed:', e.message);
    }

    // Fallback: ask Gemini to summarise from video ID (metadata only)
    try {
      const model = getModel();
      const result = await model.generateContent(
        `The YouTube video ID is "${videoId}" (URL: ${url}). ` +
        `I could not fetch the transcript automatically. ` +
        `Please write a note explaining that the transcript was unavailable and suggest the user paste the video content manually.`
      );
      return result.response.text().trim();
    } catch (geminiErr) {
      console.error('Gemini fallback error:', geminiErr.message);
    }

    return `YouTube video ID: ${videoId}. Transcript could not be fetched automatically. Please paste the content manually.`;
  } catch (err) {
    console.error('YouTube error:', err.message);
    return 'Could not fetch YouTube transcript. Please try a different video or paste content manually.';
  }
};

// ── Voice → Text (Gemini multimodal audio) ───────────────────────────────────
const extractFromVoice = async (audioUrl) => {
  try {
    const model = getModel();
    const buffer = await fetchBuffer(audioUrl);
    const base64Audio = buffer.toString('base64');

    const ext = audioUrl.split('.').pop().toLowerCase().split('?')[0];
    const mimeMap = {
      mp3: 'audio/mpeg',
      wav: 'audio/wav',
      m4a: 'audio/mp4',
      webm: 'audio/webm',
      ogg: 'audio/ogg',
      aac: 'audio/aac',
    };
    const mimeType = mimeMap[ext] || 'audio/mpeg';

    const result = await model.generateContent([
      {
        inlineData: {
          mimeType,
          data: base64Audio,
        },
      },
      'Please transcribe this audio recording into text. Return only the spoken words, no timestamps or labels.',
    ]);

    return result.response.text().trim();
  } catch (err) {
    console.error('Voice transcription error:', err.message);
    return 'Could not transcribe audio. Please try again or use PDF/image instead.';
  }
};

module.exports = {
  extractFromImage,
  extractFromPDF,
  extractFromYouTube,
  extractFromVoice,
  fetchBuffer,
};
