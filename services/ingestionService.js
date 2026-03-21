const Tesseract = require('tesseract.js');
const pdfParse  = require('pdf-parse');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const https = require('https');
const http  = require('http');
const { URL } = require('url');

// ── Fetch file buffer from any URL ────────────────────────────────────────────
const fetchBuffer = (urlStr) => new Promise((resolve, reject) => {
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
  } catch (e) { reject(e); }
});

// ── Image → Text (Tesseract OCR) ──────────────────────────────────────────────
const extractFromImage = async (imageUrl) => {
  try {
    const { data: { text } } = await Tesseract.recognize(imageUrl, 'eng', {
      logger: () => {},
    });
    return text.trim() || 'No text found in image';
  } catch (err) {
    console.error('OCR error:', err.message);
    return 'Could not extract text from image';
  }
};

// ── PDF → Text ────────────────────────────────────────────────────────────────
const extractFromPDF = async (pdfUrl) => {
  try {
    const buffer = await fetchBuffer(pdfUrl);

    if (!buffer || buffer.length === 0) {
      throw new Error('PDF file is empty or could not be downloaded');
    }

    console.log('PDF buffer size:', buffer.length, 'bytes');

    const data = await pdfParse(buffer);
    const text = data.text.trim();

    if (!text) {
      return 'PDF was processed but no text could be extracted. The PDF may contain only images.';
    }

    return text;
  } catch (err) {
    console.error('PDF error:', err.message);
    throw new Error('Could not read PDF: ' + err.message);
  }
};

// ── YouTube → Transcript ──────────────────────────────────────────────────────
const extractFromYouTube = async (url) => {
  try {
    const match = url.match(/(?:v=|youtu\.be\/|embed\/)([^&?/\s]{11})/);
    if (!match) throw new Error('Invalid YouTube URL');
    const videoId = match[1];

    try {
      const { YoutubeTranscript } = require('youtube-transcript');
      const transcript = await YoutubeTranscript.fetchTranscript(videoId);
      if (transcript && transcript.length > 0) {
        return transcript.map((t) => t.text).join(' ').trim();
      }
    } catch (e) {
      console.error('youtube-transcript failed:', e.message);
    }

    return `YouTube video ID: ${videoId}. Transcript could not be fetched. Please add notes manually.`;
  } catch (err) {
    console.error('YouTube error:', err.message);
    return 'Could not fetch YouTube transcript. Please try a different video.';
  }
};

// ── Voice → Text (Gemini multimodal) ─────────────────────────────────────────
const extractFromVoice = async (audioUrl) => {
  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash-latest' });

    const buffer = await fetchBuffer(audioUrl);
    const base64Audio = buffer.toString('base64');

    const ext = audioUrl.split('.').pop().toLowerCase().split('?')[0];
    const mimeMap = {
      mp3: 'audio/mpeg',
      wav: 'audio/wav',
      m4a: 'audio/mp4',
      webm: 'audio/webm',
      ogg: 'audio/ogg',
    };
    const mimeType = mimeMap[ext] || 'audio/mpeg';

    const result = await model.generateContent([
      { inlineData: { mimeType, data: base64Audio } },
      'Please transcribe this audio recording into text. Return only the spoken words.',
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
