const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// gemini-pro for text generation
const flashModel = genAI.getGenerativeModel({ model: 'gemini-pro' });

const extractJSON = (raw, type = 'array') => {
  try {
    raw = raw.replace(/```json|```/gi, '').trim();
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
    const result = await flashModel.generateContent(
      `Analyse this student note. Return ONLY valid JSON, no markdown:
{"subject":"Physics","chapter":"Newton Laws","keywords":["force","mass","acceleration","inertia","velocity"]}
Note: ${text.slice(0, 1200)}`
    );
    const parsed = extractJSON(result.response.text(), 'object');
    if (parsed && parsed.subject) return parsed;
    return { subject: 'General', chapter: 'Uncategorized', keywords: [] };
  } catch (err) {
    console.error('detectSubjectChapter error:', err.message);
    return { subject: 'General', chapter: 'Uncategorized', keywords: [] };
  }
};

const generateSummary = async (text) => {
  try {
    const result = await flashModel.generateContent(
      `Create a study summary with:
1. Key Concepts (bullet points)
2. Important Definitions
3. Quick Revision Points
Notes: ${text.slice(0, 4000)}`
    );
    return result.response.text();
  } catch (err) {
    console.error('generateSummary error:', err.message);
    return 'Could not generate summary. Please try again.';
  }
};

const generateFlashcards = async (text) => {
  try {
    const result = await flashModel.generateContent(
      `Create 10 flashcards from these notes.
Return ONLY a JSON array, no markdown, no explanation.
Format: [{"question":"...","answer":"..."}]
Notes: ${text.slice(0, 4000)}`
    );
    let raw = result.response.text().trim();
    raw = raw.replace(/```json|```/gi, '').trim();
    const s = raw.indexOf('['), e = raw.lastIndexOf(']');
    if (s !== -1 && e !== -1) {
      const parsed = JSON.parse(raw.slice(s, e + 1));
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
    return [{ question: 'What is the main topic?', answer: text.slice(0, 100) }];
  } catch (err) {
    console.error('generateFlashcards error:', err.message);
    return [{ question: 'Error generating flashcards', answer: 'Please try with more text' }];
  }
};

const generateQuestions = async (text) => {
  try {
    const result = await flashModel.generateContent(
      `Generate 10 exam practice questions from these notes.
Return ONLY a JSON array, no markdown, no explanation.
Format: [{"question":"...","type":"short_answer","hint":"..."}]
Notes: ${text.slice(0, 4000)}`
    );
    let raw = result.response.text().trim();
    raw = raw.replace(/```json|```/gi, '').trim();
    const s = raw.indexOf('['), e = raw.lastIndexOf(']');
    if (s !== -1 && e !== -1) {
      const parsed = JSON.parse(raw.slice(s, e + 1));
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
    return [{ question: 'Summarise the main points', type: 'short_answer', hint: 'Check your notes' }];
  } catch (err) {
    console.error('generateQuestions error:', err.message);
    return [{ question: 'Error generating questions', type: 'short_answer', hint: 'Try again' }];
  }
};

const generateMindmap = async (text) => {
  try {
    const result = await flashModel.generateContent(
      `Create a mind map from these notes.
Return ONLY a JSON object, no markdown, no explanation.
Format: {"root":"Main Topic","children":[{"label":"Subtopic","children":[{"label":"Detail"}]}]}
Notes: ${text.slice(0, 3000)}`
    );
    let raw = result.response.text().trim();
    raw = raw.replace(/```json|```/gi, '').trim();
    const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
    if (s !== -1 && e !== -1) {
      const parsed = JSON.parse(raw.slice(s, e + 1));
      if (parsed && parsed.root) return parsed;
    }
    return { root: 'Notes', children: [{ label: 'Main Topic', children: [] }] };
  } catch (err) {
    console.error('generateMindmap error:', err.message);
    return { root: 'Notes', children: [] };
  }
};

// ── Embedding — use simple hash fallback if Gemini embedding fails ────────────
const createEmbedding = async (text) => {
  // Try models in order until one works
  const embeddingModels = [
    'models/embedding-001',
    'embedding-001',
    'models/text-embedding-004',
    'text-embedding-004',
  ];

  for (const modelName of embeddingModels) {
    try {
      const embModel = genAI.getGenerativeModel({ model: modelName });
      const result = await embModel.embedContent(text.slice(0, 8000));
      console.log('Embedding model worked:', modelName);
      return result.embedding.values;
    } catch (err) {
      console.error(`Embedding model ${modelName} failed:`, err.message);
    }
  }

  // Final fallback — generate a deterministic pseudo-embedding
  // This allows upload to succeed even if all embedding models fail
  console.warn('All embedding models failed — using fallback pseudo-embedding');
  const fallback = new Array(768).fill(0).map((_, i) => {
    let hash = 0;
    const str = text.slice(0, 100) + i;
    for (let j = 0; j < str.length; j++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(j);
      hash |= 0;
    }
    return (hash % 1000) / 1000;
  });
  return fallback;
};

module.exports = {
  detectSubjectChapter,
  generateSummary,
  generateFlashcards,
  generateQuestions,
  generateMindmap,
  createEmbedding,
};
