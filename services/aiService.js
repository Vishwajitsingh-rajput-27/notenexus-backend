/**
 * NoteNexus — AI Service (Gemini Edition)
 * Uses Google Gemini 1.5 Flash for all AI tasks — completely FREE.
 * Free tier: 15 requests/min, 1 million tokens/day.
 * Get your key at: https://aistudio.google.com → Get API Key
 *
 * Gemini text-embedding-004 produces 768-dimensional vectors.
 * ⚠️  Your Pinecone index MUST be 768 dimensions (not 1536).
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Flash model for text generation — fast and free
const flashModel = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

// Embedding model — produces 768-dim vectors
const embedModel = genAI.getGenerativeModel({ model: 'text-embedding-004' });

// Safely parse JSON from Gemini response (strips markdown fences if present)
const parseJSON = (raw) => {
  try {
    return JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch {
    return null;
  }
};

// ── Auto-detect subject, chapter, keywords ─────────────────────────────────
const detectSubjectChapter = async (text) => {
  try {
    const result = await flashModel.generateContent(
      `Analyse this student note and return ONLY a JSON object with these exact fields:
- subject: the academic subject (e.g. Physics, Chemistry, Maths, History, Biology, Computer Science)
- chapter: the specific chapter or topic name
- keywords: an array of exactly 5 important keywords from the note

Note text (first 1200 chars): ${text.slice(0, 1200)}

Return ONLY valid JSON. No explanation. Example:
{"subject":"Physics","chapter":"Newton Laws","keywords":["force","mass","acceleration","inertia","velocity"]}`
    );
    return parseJSON(result.response.text()) ||
      { subject: 'General', chapter: 'Uncategorized', keywords: [] };
  } catch (err) {
    console.error('Gemini detectSubjectChapter error:', err.message);
    return { subject: 'General', chapter: 'Uncategorized', keywords: [] };
  }
};

// ── Generate structured study summary ──────────────────────────────────────
const generateSummary = async (text) => {
  try {
    const result = await flashModel.generateContent(
      `Create a clear, well-structured study summary for a student from these notes.
Format it with these sections:
1. Key Concepts (3-5 bullet points)
2. Important Definitions
3. Quick Revision Points

Notes:
${text.slice(0, 4000)}`
    );
    return result.response.text();
  } catch (err) {
    console.error('Gemini generateSummary error:', err.message);
    return 'Summary generation failed. Please try again.';
  }
};

// ── Generate flashcards ─────────────────────────────────────────────────────
const generateFlashcards = async (text) => {
  try {
    const result = await flashModel.generateContent(
      `Create exactly 10 flashcards for a student to revise these notes.
Cover the most important facts, definitions, and concepts.
Return ONLY a valid JSON array. No explanation. No markdown.
Each item must have exactly these two fields: "question" and "answer".

Notes:
${text.slice(0, 4000)}

Return ONLY the JSON array. Example format:
[{"question":"What is Newton's 1st law?","answer":"An object stays at rest or in motion unless acted on by a force."}]`
    );
    return parseJSON(result.response.text()) || [];
  } catch (err) {
    console.error('Gemini generateFlashcards error:', err.message);
    return [];
  }
};

// ── Generate practice questions ─────────────────────────────────────────────
const generateQuestions = async (text) => {
  try {
    const result = await flashModel.generateContent(
      `Generate 10 exam-style practice questions from these notes.
Mix MCQ and short answer styles.
Return ONLY a valid JSON array. No explanation. No markdown.
Each item must have: "question" (string), "type" ("MCQ" or "short_answer"), "hint" (brief hint string).

Notes:
${text.slice(0, 4000)}

Return ONLY the JSON array.`
    );
    return parseJSON(result.response.text()) || [];
  } catch (err) {
    console.error('Gemini generateQuestions error:', err.message);
    return [];
  }
};

// ── Generate mind map JSON ──────────────────────────────────────────────────
const generateMindmap = async (text) => {
  try {
    const result = await flashModel.generateContent(
      `Create a mind map structure from these student notes.
Return ONLY a valid JSON object. No explanation. No markdown.
Use this exact structure:
{
  "root": "Main Topic Name",
  "children": [
    {
      "label": "Subtopic 1",
      "children": [
        {"label": "Detail A"},
        {"label": "Detail B"}
      ]
    },
    {
      "label": "Subtopic 2",
      "children": [
        {"label": "Detail C"}
      ]
    }
  ]
}

Notes:
${text.slice(0, 3000)}

Return ONLY the JSON object.`
    );
    return parseJSON(result.response.text()) || { root: 'Notes', children: [] };
  } catch (err) {
    console.error('Gemini generateMindmap error:', err.message);
    return { root: 'Notes', children: [] };
  }
};

// ── Create text embedding (768 dimensions) ──────────────────────────────────
const createEmbedding = async (text) => {
  try {
    const result = await embedModel.embedContent(text.slice(0, 8000));
    return result.embedding.values; // 768-dimensional float array
  } catch (err) {
    console.error('Gemini createEmbedding error:', err.message);
    throw err;
  }
};

module.exports = {
  detectSubjectChapter,
  generateSummary,
  generateFlashcards,
  generateQuestions,
  generateMindmap,
  createEmbedding,
};
