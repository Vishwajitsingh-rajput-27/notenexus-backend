const https = require('https');

// ── Groq text generation — llama-3.3-70b (free, fast, generous limits) ────────
const groqCall = (prompt) => new Promise((resolve, reject) => {
  const body = JSON.stringify({
    model: 'llama-3.3-70b-versatile',
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 2048,
    temperature: 0.3
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
        console.log('✅ Groq llama call succeeded');
        resolve(text);
      } catch (e) { reject(e); }
    });
  });
  req.on('error', reject);
  req.setTimeout(30000, () => { req.destroy(); reject(new Error('Groq timeout')); });
  req.write(body);
  req.end();
});

// ── Gemini embeddings — kept for 768-dim Pinecone vectors (free) ──────────────
const geminiEmbed = (text) => new Promise((resolve) => {
  const models = ['text-embedding-004', 'embedding-001'];
  const body = JSON.stringify({ content: { parts: [{ text: text.slice(0, 8000) }] } });

  const tryModel = (index) => {
    if (index >= models.length) {
      console.warn('All embedding models failed — using deterministic fallback');
      return resolve(new Array(768).fill(0).map((_, i) => {
        let h = 0;
        const str = text.slice(0, 50) + i;
        for (let j = 0; j < str.length; j++) { h = ((h << 5) - h) + str.charCodeAt(j); h |= 0; }
        return (h % 1000) / 1000;
      }));
    }

    const options = {
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/${models[index]}:embedContent?key=${process.env.GEMINI_API_KEY}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error || !parsed.embedding?.values) return tryModel(index + 1);
          console.log(`✅ Embedding model ${models[index]} succeeded`);
          resolve(parsed.embedding.values);
        } catch { tryModel(index + 1); }
      });
    });
    req.on('error', () => tryModel(index + 1));
    req.setTimeout(15000, () => { req.destroy(); tryModel(index + 1); });
    req.write(body);
    req.end();
  };

  tryModel(0);
});

// ── JSON extraction helper ────────────────────────────────────────────────────
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

// ── Detect subject + chapter ──────────────────────────────────────────────────
const detectSubjectChapter = async (text) => {
  try {
    if (!text || text.trim().length < 10) {
      return { subject: 'General', chapter: 'Uncategorized', keywords: [] };
    }
    const raw = await groqCall(
      `Analyse this student note. Return ONLY valid JSON, no markdown, no explanation:
{"subject":"Physics","chapter":"Newton Laws","keywords":["force","mass","acceleration"]}
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

// ── Generate study summary ────────────────────────────────────────────────────
const generateSummary = async (text) => {
  try {
    return await groqCall(`Create a study summary with:
1. Key Concepts (bullet points)
2. Important Definitions
3. Quick Revision Points
Notes: ${text.slice(0, 4000)}`);
  } catch (err) {
    return 'Could not generate summary. Please try again.';
  }
};

// ── Generate flashcards ───────────────────────────────────────────────────────
const generateFlashcards = async (text) => {
  try {
    const raw = await groqCall(`Create 10 flashcards from these notes.
Return ONLY a JSON array, no markdown, no explanation.
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

// ── Generate practice questions ───────────────────────────────────────────────
const generateQuestions = async (text) => {
  try {
    const raw = await groqCall(`Generate 10 exam practice questions.
Return ONLY a JSON array, no markdown, no explanation.
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

// ── Generate mind map ─────────────────────────────────────────────────────────
const generateMindmap = async (text) => {
  try {
    const raw = await groqCall(`Create a mind map from these notes.
Return ONLY a JSON object, no markdown, no explanation.
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

// ── Create embedding vector ───────────────────────────────────────────────────
const createEmbedding = async (text) => {
  return await geminiEmbed(text);
};

module.exports = {
  detectSubjectChapter, generateSummary, generateFlashcards,
  generateQuestions, generateMindmap, createEmbedding,
};
