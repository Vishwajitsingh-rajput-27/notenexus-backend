const Tesseract = require('tesseract.js');
const pdfParse  = require('pdf-parse');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const https = require('https');
const http  = require('http');
const { URL } = require('url');

const fetchBuffer = (urlStr) => new Promise((resolve, reject) => {
  try {
    const parsed = new URL(urlStr);
    const lib = parsed.protocol === 'https:' ? https : http;
    lib.get(urlStr, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  } catch (e) { reject(e); }
});

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

const extractFromPDF = async (pdfUrl) => {
  try {
    const buffer = await fetchBuffer(pdfUrl);
    const data = await pdfParse(buffer);
    return data.text.trim() || 'No text found in PDF';
  } catch (err) {
    console.error('PDF error:', err.message);
    throw new Error('Could not read PDF file');
  }
};

const extractFromYouTube = async (url) => {
  try {
    // Extract video ID
    const match = url.match(/(?:v=|youtu\.be\/|embed\/)([^&?/\s]{11})/);
    if (!match) throw new Error('Invalid YouTube URL');
    const videoId = match[1];

    // Try youtube-transcript package
    try {
      const { YoutubeTranscript } = require('youtube-transcript');
      const transcript = await YoutubeTranscript.fetchTranscript(videoId);
      if (transcript && transcript.length > 0) {
        return transcript.map((t) => t.text).join(' ').trim();
      }
    } catch (e) {
      console.error('youtube-transcript failed:', e.message);
    }

    // Fallback — return video ID as note
    return `YouTube video ID: ${videoId}. Transcript could not be fetched automatically. Please add notes manually.`;
  } catch (err) {
    console.error('YouTube error:', err.message);
    return 'Could not fetch YouTube transcript. Please try a different video.';
  }
};

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
      {
        inlineData: {
          mimeType,
          data: base64Audio,
        },
      },
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
