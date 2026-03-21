/**
 * NoteNexus — Ingestion Service (Gemini Edition)
 * Extracts text from: images (Tesseract OCR), PDFs, YouTube, voice audio.
 * Voice transcription now uses Gemini 1.5 Flash (multimodal) instead of Whisper.
 */

const Tesseract = require('tesseract.js');
const pdfParse  = require('pdf-parse');
const { YoutubeTranscript } = require('youtube-transcript-api');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const https = require('https');
const http  = require('http');
const { URL } = require('url');

// Fetch a file buffer from any URL (used for Cloudinary URLs)
const fetchBuffer = (urlStr) => new Promise((resolve, reject) => {
  const parsed = new URL(urlStr);
  const lib = parsed.protocol === 'https:' ? https : http;
  lib.get(urlStr, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', reject);
  }).on('error', reject);
});

// ── Image → Text (Tesseract OCR) ────────────────────────────────────────────
const extractFromImage = async (imageUrl) => {
  const { data: { text } } = await Tesseract.recognize(imageUrl, 'eng', {
    logger: () => {}, // suppress progress logs
  });
  return text.trim();
};

// ── PDF → Text ───────────────────────────────────────────────────────────────
const extractFromPDF = async (pdfUrl) => {
  const buffer = await fetchBuffer(pdfUrl);
  const data = await pdfParse(buffer);
  return data.text.trim();
};

// ── YouTube URL → Transcript text ────────────────────────────────────────────
const extractFromYouTube = async (url) => {
  // Support both full URLs and short URLs
  const match = url.match(/(?:v=|youtu\.be\/|embed\/)([^&?/]+)/);
  if (!match) throw new Error('Invalid YouTube URL — could not extract video ID');
  const transcript = await YoutubeTranscript.fetchTranscript(match[1]);
  return transcript.map((t) => t.text).join(' ').trim();
};

// ── Voice/Audio → Text (Gemini 1.5 Flash multimodal) ─────────────────────────
const extractFromVoice = async (audioUrl) => {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

  // Fetch the audio file as a buffer from Cloudinary
  const buffer = await fetchBuffer(audioUrl);
  const base64Audio = buffer.toString('base64');

  // Determine MIME type from URL extension
  const ext = audioUrl.split('.').pop().toLowerCase().split('?')[0];
  const mimeMap = {
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    m4a: 'audio/mp4',
    webm: 'audio/webm',
    ogg: 'audio/ogg',
    flac: 'audio/flac',
  };
  const mimeType = mimeMap[ext] || 'audio/mpeg';

  const result = await model.generateContent([
    {
      inlineData: {
        mimeType,
        data: base64Audio,
      },
    },
    'Please transcribe this audio recording into text. Return only the transcribed words, no commentary.',
  ]);

  return result.response.text().trim();
};

module.exports = {
  extractFromImage,
  extractFromPDF,
  extractFromYouTube,
  extractFromVoice,
  fetchBuffer, // exported for use in other services if needed
};
