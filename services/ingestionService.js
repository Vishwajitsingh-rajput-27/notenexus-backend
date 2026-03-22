const pdfParse = require('pdf-parse');
const https = require('https');
const http  = require('http');
const { URL } = require('url');
const FormData = require('form-data');

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
      request.setTimeout(60000, () => { request.destroy(); reject(new Error('Request timeout')); });
    } catch (e) { reject(e); }
  });

// ── Groq Vision API — for image and scanned PDF ───────────────────────────────
const groqVision = (base64Data, mimeType, prompt) => new Promise((resolve, reject) => {
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
        const text = parsed.choices?.[0]?.message?.content || '';
        resolve(text.trim());
      } catch (e) { reject(e); }
    });
  });
  req.on('error', reject);
  req.setTimeout(60000, () => { req.destroy(); reject(new Error('Groq vision timeout')); });
  req.write(body);
  req.end();
});

// ── Groq Whisper API — for voice transcription ────────────────────────────────
const groqWhisper = (audioBuffer, filename) => new Promise((resolve, reject) => {
  const form = new FormData();
  form.append('file', audioBuffer, { filename: filename || 'audio.mp3', contentType: 'audio/mpeg' });
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
  req.setTimeout(120000, () => { req.destroy(); reject(new Error('Whisper timeout')); });
  form.pipe(req);
});

// ── Validate extracted text ───────────────────────────────────────────────────
const validateText = (text, source) => {
  if (!text || typeof text !== 'string') throw new Error(`No text returned from ${source}`);
  const trimmed = text.trim();
  if (trimmed.length < 10) throw new Error(`Extracted text too short from ${source}`);
  return trimmed;
};

// ── Image → Text (Groq Vision) ────────────────────────────────────────────────
const extractFromImage = async (imageUrl) => {
  console.log('extractFromImage called with:', imageUrl);
  const buffer = await fetchBuffer(imageUrl);
  console.log('Image buffer size:', buffer.length, 'bytes');
  const ext = imageUrl.split('.').pop().toLowerCase().split('?')[0];
  const mimeMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
  const mimeType = mimeMap[ext] || 'image/jpeg';
  const base64Image = buffer.toString('base64');
  const text = await groqVision(base64Image, mimeType,
    'Extract and transcribe ALL text visible in this image. Return only the text content, preserving structure where possible. If there is no text, describe what you see.'
  );
  console.log('Groq vision result length:', text?.length);
  return validateText(text, 'image');
};

// ── PDF → Text (pdf-parse + Groq Vision fallback) ─────────────────────────────
const extractFromPDF = async (pdfUrl) => {
  console.log('extractFromPDF called with:', pdfUrl);
  const buffer = await fetchBuffer(pdfUrl);
  console.log('PDF buffer size:', buffer.length, 'bytes');

  try {
    const data = await pdfParse(buffer);
    const text = data.text?.trim();
    if (text && text.length > 50) {
      console.log('pdf-parse succeeded, length:', text.length);
      return text;
    }
    console.log('pdf-parse got no text — trying Groq Vision');
  } catch (e) {
    console.error('pdf-parse error:', e.message, '— trying Groq Vision');
  }

  // Scanned PDF fallback — send as base64 image to Groq Vision
  const base64PDF = buffer.toString('base64');
  const text = await groqVision(base64PDF, 'image/jpeg',
    'This is a scanned PDF page. Extract and transcribe ALL text you can see. Return only the text content.'
  );
  console.log('Groq vision PDF fallback length:', text?.length);
  return validateText(text, 'PDF');
};

// ── YouTube → Transcript ──────────────────────────────────────────────────────
const extractFromYouTube = async (url) => {
  console.log('extractFromYouTube called with:', url);
  const match = url.match(/(?:v=|youtu\.be\/|embed\/)([^&?/\s]{11})/);
  if (!match) throw new Error('Invalid YouTube URL');
  const videoId = match[1];
  console.log('YouTube video ID:', videoId);

  // Method 1: youtubei.js
  try {
    const { Innertube } = await import('youtubei.js');
    const yt = await Innertube.create({ retrieve_player: false });
    const info = await yt.getInfo(videoId);
    const transcriptData = await info.getTranscript();
    const segments = transcriptData?.transcript?.content?.body?.initial_segments;
    if (segments && segments.length > 0) {
      const text = segments.map((s) => s.snippet?.text || '').filter(Boolean).join(' ').trim();
      if (text.length > 20) { console.log('youtubei.js success, length:', text.length); return text; }
    }
  } catch (e) { console.error('youtubei.js failed:', e.message); }

  // Method 2: youtube-transcript
  try {
    const { YoutubeTranscript } = await import('youtube-transcript');
    const transcript = await YoutubeTranscript.fetchTranscript(videoId);
    if (transcript && transcript.length > 0) {
      const text = transcript.map((t) => t.text).join(' ').trim();
      console.log('youtube-transcript success, length:', text.length);
      return text;
    }
  } catch (e) { console.error('youtube-transcript failed:', e.message); }

  throw new Error(
    `Could not fetch transcript for video ${videoId}. ` +
    `Open YouTube → click ··· → "Show transcript" → copy and paste manually.`
  );
};

// ── Voice → Text (Groq Whisper) ───────────────────────────────────────────────
const extractFromVoice = async (audioUrl) => {
  console.log('extractFromVoice called with:', audioUrl);
  const buffer = await fetchBuffer(audioUrl);
  console.log('Audio buffer size:', buffer.length, 'bytes');
  const ext = audioUrl.split('.').pop().toLowerCase().split('?')[0];
  const filename = `audio.${ext || 'mp3'}`;
  const text = await groqWhisper(buffer, filename);
  console.log('Whisper transcription length:', text?.length);
  return validateText(text, 'audio');
};

module.exports = { extractFromImage, extractFromPDF, extractFromYouTube, extractFromVoice, fetchBuffer };
