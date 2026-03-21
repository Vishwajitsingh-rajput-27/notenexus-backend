/**
 * NoteNexus — Vector Search Service (Gemini Edition)
 * Uses Gemini text-embedding-004 which produces 768-dimensional vectors.
 *
 * ⚠️  PINECONE INDEX MUST HAVE 768 DIMENSIONS (not 1536).
 * Delete old index and create a new one at app.pinecone.io:
 *   Name: notenexus | Dimensions: 768 | Metric: cosine | Serverless (free)
 */

const { Pinecone } = require('@pinecone-database/pinecone');
const { createEmbedding } = require('./aiService');

let index;

const getIndex = async () => {
  if (!index) {
    const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
    index = pc.index(process.env.PINECONE_INDEX_NAME);
  }
  return index;
};

// Store a note embedding in Pinecone
const storeEmbedding = async (noteId, text, metadata) => {
  const idx = await getIndex();
  const vector = await createEmbedding(text);
  // Pinecone metadata values must be strings or numbers — no nulls
  const clean = {};
  for (const [k, v] of Object.entries(metadata)) {
    clean[k] = String(v ?? '');
  }
  await idx.upsert([{ id: noteId, values: vector, metadata: clean }]);
};

// Semantic search across a user's notes
const semanticSearch = async (query, userId, topK = 8) => {
  const idx = await getIndex();
  const vector = await createEmbedding(query);
  const results = await idx.query({
    vector,
    topK,
    filter: { userId },
    includeMetadata: true,
  });
  return results.matches || [];
};

// Delete a note embedding from Pinecone
const deleteEmbedding = async (noteId) => {
  const idx = await getIndex();
  await idx.deleteOne(noteId);
};

module.exports = { storeEmbedding, semanticSearch, deleteEmbedding };
