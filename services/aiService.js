const https = require('https');

const KEY = () => process.env.GEMINI_API_KEY;

// Direct REST call — v1beta with gemini-1.5-flash-001
const geminiCall = (prompt) => new Promise((resolve, reject) => {
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.3, maxOutputTokens: 2048 }
  });

  // Try models in order
  const models = [
    'gemini-1.5-flash-001',
    'gemini-1.5-flash',
    'gemini-1.0-pro',
  ];

  const tryModel = (index) => {
    if (index >= models.length) return reject(new Error('All models failed'));
    const model = models[index];
    const bodyStr = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 2048 }
    });

    const options = {
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/${model}:generateContent?key=${KEY()}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            console.error(`Model ${model} failed:`, parsed.error.message);
            return tryModel(index + 1);
          }
          const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text || '';
          console.log(`Model ${model} succeeded`);
          resolve(text);
        } catch (e) { tryModel(index + 1); }
      });
    });
    req.on('error', () => tryModel(index + 1));
    req.setTimeout(30000, () => { req.destroy(); tryModel(index + 1); });
    req.write(bodyStr);
    req.end();
  };

  tryModel(0);
});

// Embedding with fallback
const geminiEmbed = (text) => new Promise((resolve) => {
  const body = JSON.stringify({ content: { parts: [{ text: text.slice(0, 8000) }] } });
  const models = ['text-embedding-004', 'embedding-001'];

  const tryModel = (index) => {
    if (index >= models.length) {
      console.warn('All embedding models failed — using fallback');
      return resolve(new Array(768).fill(0).map((_, i) => {
        let h = 0;
        const str = text.slice(0, 50) + i;
        for (let j = 0; j < str.length; j++) { h = ((h << 5) - h) + str.charCodeAt(j); h |= 0; }
        return (h % 1000) / 1000;
      }));
    }

    const options = {
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/${models[index]}:embedContent?key=${KEY()}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error || !parsed.embedding) return tryModel(index + 1);
          console.log(`Embedding model ${models[index]} succeeded`);
          resolve(parsed.embedding.values);
        } catch { tryModel(index + 1); }
      });
    });
    req.on('error', () => tryModel(index + 1));
    req.write(body);
    req.end();
  };

  tryModel(0);
});

const extractJSON = (raw, type = 'array') => {
  try {
    raw = (raw || '').replace(/```json|```/gi, '').trim();
    if (type === 'array') {
      const s = raw.indexOf('['), e = raw.lastIndexOf(']');
      if (s !== -1 && e !== -1) return JSON.parse(raw.slice(s, e + 1));
    } else {
      const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
      if (s !== -1 && e !== -1) return JSON.parse(raw.slice(s, e + 1));
    }
    return JSON.parse(raw);
  } catch { return type === 'array' ? [] : {}; }
};

const detectSubjectChapter = async (text) => {
  try {
    const raw = await geminiCall(
      `Analyse this student note. Return ONLY valid JSON no markdown:
{"subject":"Physics","chapter":"Newton Laws","keywords":["force","mass","acceleration","inertia","velocity"]}
Note: ${text.slice(0, 1200)}`
    );
    const parsed = extractJSON(raw, 'object');
    if (parsed && parsed.subject) return parsed;
    return { subject: 'General', chapter: 'Uncategorized', keywords: [] };
  } catch (err) {
    console.error('detectSubjectChapter error:', err.message);
    return { subject: 'General', chapter: 'Uncategorized', keywords: [] };
  }
};

const generateSummary = async (text) => {
  try {
    return await geminiCall(`Create a study summary with:
1. Key Concepts (bullet points)
2. Important Definitions
3. Quick Revision Points
Notes: ${text.slice(0, 4000)}`);
  } catch (err) {
    return 'Could not generate summary. Please try again.';
  }
};

const generateFlashcards = async (text) => {
  try {
    const raw = await geminiCall(`Create 10 flashcards from these notes.
Return ONLY a JSON array no markdown no explanation.
Format: [{"question":"...","answer":"..."}]
Notes: ${text.slice(0, 4000)}`);
    const parsed = extractJSON(raw, 'array');
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    return [{ question: 'What is the main topic?', answer: text.slice(0, 100) }];
  } catch (err) {
    console.error('generateFlashcards error:', err.message);
    return [{ question: 'Error', answer: 'Please try again' }];
  }
};

const generateQuestions = async (text) => {
  try {
    const raw = await geminiCall(`Generate 10 exam practice questions.
Return ONLY a JSON array no markdown no explanation.
Format: [{"question":"...","type":"short_answer","hint":"..."}]
Notes: ${text.slice(0, 4000)}`);
    const parsed = extractJSON(raw, 'array');
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    return [{ question: 'Summarise the main points', type: 'short_answer', hint: 'Check notes' }];
  } catch (err) {
    console.error('generateQuestions error:', err.message);
    return [{ question: 'Error', type: 'short_answer', hint: 'Try again' }];
  }
};

const generateMindmap = async (text) => {
  try {
    const raw = await geminiCall(`Create a mind map from these notes.
Return ONLY a JSON object no markdown no explanation.
Format: {"root":"Main Topic","children":[{"label":"Subtopic","children":[{"label":"Detail"}]}]}
Notes: ${text.slice(0, 3000)}`);
    const parsed = extractJSON(raw, 'object');
    if (parsed && parsed.root) return parsed;
    return { root: 'Notes', children: [{ label: 'Main Topic', children: [] }] };
  } catch (err) {
    console.error('generateMindmap error:', err.message);
    return { root: 'Notes', children: [] };
  }
};

const createEmbedding = async (text) => {
  return await geminiEmbed(text);
};

module.exports = {
  detectSubjectChapter, generateSummary, generateFlashcards,
  generateQuestions, generateMindmap, createEmbedding,
};
