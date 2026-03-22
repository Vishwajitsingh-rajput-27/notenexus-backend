const pdfParse = require('pdf-parse');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const https = require('https');
const http  = require('http');
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
          return reject(new Error(`HTTP ${res.statusCode} fetching file`));
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
        reject(new Error('Request timeout fetching file'));
      });
    } catch (e) {
      reject(e);
    }
  });

// ── Validate extracted text — throws if result is empty or too short ──────────
const validateText = (text, source) => {
  if (!text || typeof text !== 'string') {
    throw new Error(`No text returned from ${source}`);
  }
  const trimmed = text.trim();
  if (trimmed.length < 10) {
    throw new Error(`Extracted text too short from ${source}`);
  }
  return trimmed;
};

// ── Image → Text (Gemini Vision) ──────────────────────────────────────────────
const extractFromImage = async (imageUrl) => {
  console.log('extractFromImage called with:', imageUrl);
  const model = getModel();
  const buffer = await fetchBuffer(imageUrl);
  console.log('Image buffer size:', buffer.length, 'bytes');

  const base64Image = buffer.toString('base64');

  const ext = imageUrl.split('.').pop().toLowerCase().split('?')[0];
  const mimeMap = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg',
    png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  };
  const mimeType = mimeMap[ext] || 'image/jpeg';
  console.log('Image mimeType:', mimeType);

  const result = await model.generateContent([
    { inlineData: { mimeType, data: base64Image } },
    'Extract and transcribe ALL text visible in this image. Return only the text content, preserving structure where possible.',
  ]);

  const text = result.response.text();
  console.log('Gemini image extraction result length:', text?.length);
  return validateText(text, 'image');
};

// ── PDF → Text (pdf-parse first, Gemini Vision fallback for scanned PDFs) ─────
const extractFromPDF = async (pdfUrl) => {
  console.log('extractFromPDF called with:', pdfUrl);
  const buffer = await fetchBuffer(pdfUrl);
  console.log('PDF buffer size:', buffer.length, 'bytes');

  // Try pdf-parse first (fast, works for text-based PDFs)
  try {
    const data = await pdfParse(buffer);
    const text = data.text?.trim();
    if (text && text.length > 50) {
      console.log('pdf-parse succeeded, text length:', text.length);
      return text;
    }
    console.log('pdf-parse returned no text — trying Gemini Vision fallback');
  } catch (parseErr) {
    console.error('pdf-parse error:', parseErr.message, '— trying Gemini Vision fallback');
  }

  // Fallback: scanned PDF — send to Gemini Vision as base64
  const base64PDF = buffer.toString('base64');
  const model = getModel();

  const result = await model.generateContent([
    { inlineData: { mimeType: 'application/pdf', data: base64PDF } },
    'Extract and transcribe ALL text from this PDF document. Return only the text content.',
  ]);

  const text = result.response.text();
  console.log('Gemini PDF extraction result length:', text?.length);
  return validateText(text, 'PDF');
};

// ── YouTube → Transcript ──────────────────────────────────────────────────────
const extractFromYouTube = async (url) => {
  console.log('extractFromYouTube called with:', url);
  const match = url.match(/(?:v=|youtu\.be\/|embed\/)([^&?/\s]{11})/);
  if (!match) throw new Error('Invalid YouTube URL — could not extract video ID');
  const videoId = match[1];
  console.log('YouTube video ID:', videoId);

  // Method 1: youtubei.js — mimics real browser, most reliable
  try {
    const { Innertube } = await import('youtubei.js');
    const yt = await Innertube.create({ retrieve_player: false });
    const info = await yt.getInfo(videoId);
    const transcriptData = await info.getTranscript();
    const segments = transcriptData?.transcript?.content?.body?.initial_segments;
    if (segments && segments.length > 0) {
      const text = segments.map((s) => s.snippet?.text || '').filter(Boolean).join(' ').trim();
      if (text.length > 20) {
        console.log('youtubei.js transcript length:', text.length);
        return text;
      }
    }
  } catch (e) {
    console.error('youtubei.js failed:', e.message);
  }

  // Method 2: youtube-transcript (ESM — dynamic import required)
  try {
    const { YoutubeTranscript } = await import('youtube-transcript');
    const transcript = await YoutubeTranscript.fetchTranscript(videoId);
    if (transcript && transcript.length > 0) {
      const text = transcript.map((t) => t.text).join(' ').trim();
      console.log('youtube-transcript length:', text.length);
      return text;
    }
  } catch (e) {
    console.error('youtube-transcript failed:', e.message);
  }

  // Both failed — throw a clear error so the frontend shows a useful message
  throw new Error(
    `Could not fetch transcript for YouTube video ${videoId}. ` +
    `The video may not have captions enabled. ` +
    `Open YouTube → click ··· under the video → "Show transcript" → copy and paste it manually.`
  );
};

// ── Voice → Text (Gemini multimodal audio) ───────────────────────────────────
const extractFromVoice = async (audioUrl) => {
  console.log('extractFromVoice called with:', audioUrl);
  const model = getModel();
  const buffer = await fetchBuffer(audioUrl);
  console.log('Audio buffer size:', buffer.length, 'bytes');

  const base64Audio = buffer.toString('base64');
  const ext = audioUrl.split('.').pop().toLowerCase().split('?')[0];
  const mimeMap = {
    mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4',
    webm: 'audio/webm', ogg: 'audio/ogg', aac: 'audio/aac',
  };
  const mimeType = mimeMap[ext] || 'audio/mpeg';
  console.log('Audio mimeType:', mimeType);

  const result = await model.generateContent([
    { inlineData: { mimeType, data: base64Audio } },
    'Please transcribe this audio recording into text. Return only the spoken words, no timestamps or labels.',
  ]);

  const text = result.response.text();
  console.log('Gemini voice transcription length:', text?.length);
  return validateText(text, 'audio');
};

module.exports = {
  extractFromImage,
  extractFromPDF,
  extractFromYouTube,
  extractFromVoice,
  fetchBuffer,
};
