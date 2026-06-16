/**
 * Persistent per-user memory layer.
 *
 * After each non-error conversation turn the agent fires extractAndSaveMemories()
 * (fire-and-forget). It calls the fast LLM to distil 1-3 short "facts" about the
 * user from the Q+A pair and appends them to data/user-memory.jsonl.
 *
 * On the NEXT turn, getUserMemories() reads back the N most-recent unique facts
 * for that user, which agent.js injects into the system prompt as a
 * "What I know about you" block.  This gives the model persistent context
 * across sessions without needing a vector DB or external service.
 *
 * Storage: SQLite `user_memory` table (see embeddings/db.js).
 * Format:  { email, fact, at }
 *
 * Privacy: facts are scoped by email — each user only ever sees their own.
 */
const config = require('../config');
const db = require('./db');

// ──────────────────────────────────────────────────────────────────────────────
// Read/write helpers
// ──────────────────────────────────────────────────────────────────────────────

function normEmail(v) {
  return String(v || '').trim().toLowerCase();
}

/** All facts for a user, oldest-first (matches the previous append order). */
function readAllMemories(userEmail) {
  const email = normEmail(userEmail);
  if (!email) return [];
  return db.getMemoriesByEmail(email).filter(r => r && typeof r.fact === 'string');
}

// Cap on retained memory rows per user. Older rows beyond the cap are
// dropped during compaction (see _compactIfOverCap below). A bounded cap
// keeps the JSONL file from growing unbounded across months of use, and
// matches the "newest is most relevant" assumption already baked into
// getUserMemories().
const MAX_ROWS_PER_USER = 50;

/** Normalise a fact for duplicate detection: lowercase, collapse internal
 *  whitespace, strip surrounding/trailing punctuation. Two facts that
 *  normalise to the same string are treated as duplicates. */
function _normFact(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^[\s.,;:!?'"`)\]}-]+|[\s.,;:!?'"`)\]}-]+$/g, '')
    .trim();
}

/** Keep only this user's newest MAX_ROWS_PER_USER rows. Best-effort. */
function _compactIfOverCap(userEmail) {
  const email = normEmail(userEmail);
  if (!email) return;
  try {
    db.pruneMemoryBeyondCap(email, MAX_ROWS_PER_USER);
  } catch (err) {
    console.warn('[chatbot memory] compaction failed:', err.message || err);
  }
}

function appendMemory(entry) {
  try {
    // Skip exact-duplicate facts for the same user. Normalised matching
    // catches casing / punctuation drift so the same fact ("Owns Project X")
    // doesn't accumulate rows across conversations.
    const normNew = _normFact(entry.fact);
    if (normNew && entry.email) {
      const existing = readAllMemories(entry.email);
      if (existing.some(r => _normFact(r.fact) === normNew)) {
        return;
      }
    }

    db.insertMemory({ email: entry.email, fact: entry.fact, at: entry.at });
    _compactIfOverCap(entry.email);
  } catch (err) {
    console.warn('[chatbot memory] append failed:', err.message || err);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Get the most-recent N unique memory facts for a user.
 * Deduplication is text-prefix based: the last seen occurrence of similar
 * facts wins, so stale facts get naturally overwritten by fresh ones.
 *
 * @param {string} userEmail
 * @param {number} [limit=12]
 * @returns {{ email: string, fact: string, at: string }[]}
 */
function getUserMemories(userEmail, limit) {
  if (!userEmail) return [];
  const maxFacts = limit || 12;
  const all = readAllMemories(userEmail);

  // Deduplicate: traverse newest-first, keep first occurrence of each prefix.
  const seen = new Set();
  const deduped = [];
  for (let i = all.length - 1; i >= 0; i--) {
    const key = String(all[i].fact || '').toLowerCase().slice(0, 60);
    if (!seen.has(key)) {
      seen.add(key);
      deduped.unshift(all[i]);
    }
  }
  return deduped.slice(-maxFacts);
}

/**
 * Format a memory list as a system-prompt block.
 * Returns '' if no memories exist (safe to concatenate directly).
 */
function formatMemoryBlock(memories) {
  if (!memories || !memories.length) return '';
  const facts = memories.map(m => `- ${m.fact}`).join('\n');
  return `\n\n--- Persistent context about this user ---\n${facts}\n--- End user context ---`;
}

/**
 * Extract 1-3 memory facts from a Q+A pair using the fast LLM, then persist
 * them for this user. Completely fire-and-forget — never throws, never blocks
 * the main response path.
 *
 * @param {{ question: string, answer: string, userEmail: string,
 *           openRouterFetch: Function, apiKey: string }} opts
 */
async function extractAndSaveMemories({ question, answer, userEmail, openRouterFetch, apiKey }) {
  if (!userEmail || !openRouterFetch || !apiKey) return;
  const model = config.model.fastModel;

  const messages = [
    {
      role: 'system',
      content:
        'You extract short, reusable memory facts about a user from their conversation with ' +
        'an engineering dashboard AI assistant. Return ONLY a JSON array of 1-3 facts ' +
        '(≤100 chars each) worth remembering for future sessions — things like which projects ' +
        'they own, their role, their team, ongoing concerns, or stated preferences. ' +
        'Return [] if nothing worth persisting. No prose, no markdown. ' +
        'Good examples: ["Owns Project Athena", "QA manager for HDE", "Concerned about PI 24.3 slippage"]',
    },
    {
      role: 'user',
      content: `User question: ${question.slice(0, 300)}\n\nBot answer (first 400 chars): ${answer.slice(0, 400)}`,
    },
  ];

  try {
    const res = await openRouterFetch(
      { model, messages, temperature: 0.1, max_tokens: 160, stream: false },
      apiKey,
      'https://localhost',
    );
    if (!res || res.status < 200 || res.status >= 300) return;
    const raw = (res.data?.choices?.[0]?.message?.content || '').trim();
    const m = raw.match(/\[[\s\S]*\]/);
    if (!m) return;
    const facts = JSON.parse(m[0]);
    if (!Array.isArray(facts)) return;
    for (const fact of facts) {
      if (typeof fact === 'string' && fact.trim()) {
        appendMemory({
          email: normEmail(userEmail),
          fact: fact.trim(),
          at: new Date().toISOString(),
        });
      }
    }
  } catch (_) {
    // Always swallow — this is best-effort enrichment, never a blocker.
  }
}

module.exports = {
  getUserMemories,
  formatMemoryBlock,
  extractAndSaveMemories,
};
