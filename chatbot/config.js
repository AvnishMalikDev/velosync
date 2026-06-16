/**
 * Chatbot configuration.
 *
 * Loads JIRA + GitHub credentials from `../jira-md-export/.env` (read-only,
 * never copied). The root `.env` is already loaded by server.js at startup,
 * so OPENROUTER_API_KEY and other root-level vars are already in process.env.
 */
const path = require('path');

const ROOT_ENV_PATH = path.join(__dirname, '..', '.env');
const JIRA_ENV_PATH = path.join(__dirname, '..', 'jira-md-export', '.env');

// Load both env files. Root .env is usually already loaded by server.js but we
// load it here too so this module is testable / runnable standalone.
// override:false means whatever was set first wins (server.js wins over us,
// and within our load, root .env wins over jira-md-export/.env for shared keys).
require('dotenv').config({ path: ROOT_ENV_PATH,  override: false });
require('dotenv').config({ path: JIRA_ENV_PATH,  override: false });

const ROOT = path.join(__dirname, '..');

module.exports = {
  paths: {
    root: ROOT,
    output: path.join(ROOT, 'output'),
    resourceDirectory: path.join(ROOT, 'output', 'resource-directory.json'),
    cursorData:        path.join(ROOT, 'output', 'cursordata.json'),
    copilotData:       path.join(ROOT, 'output', 'copilotdata.json'),
    testrailUsers:     path.join(ROOT, 'output', 'testrail-users.json'),
    projectsConfig:    path.join(ROOT, 'jira-md-export', 'projects.json'),
    jiraEnv: JIRA_ENV_PATH,
    // SQLite store (better-sqlite3) ù canonical home for the docs vector index,
    // qa-history, and user-memory. Replaces the old docs.index.json (re-parsed
    // on every query) + the two JSONL files. The three paths below are retained
    // ONLY so db.js can do a one-time import of pre-existing data into SQLite.
    db: path.join(__dirname, 'data', 'chatbot.db'),
    docsIndex: path.join(__dirname, 'data', 'docs.index.json'),
    qaHistory: path.join(__dirname, 'data', 'qa-history.jsonl'),
    userMemory: path.join(__dirname, 'data', 'user-memory.jsonl'),
    cache: path.join(__dirname, '.cache'),
    githubMetricsModule:    path.join(__dirname, '..', 'jira-md-export', 'get-github-metrics.js'),
    confluenceModule:       path.join(__dirname, '..', 'jira-md-export', 'get-confluence-data.js'),
    testrailModule:         path.join(__dirname, '..', 'jira-md-export', 'get-testrail-data.js'),
  },
  model: {
    embedding: 'Xenova/all-MiniLM-L6-v2',
    embeddingDim: 384,
    chatDefault: process.env.CHATBOT_MODEL || 'anthropic/claude-sonnet-4.6',
    // Cheap, fast model used for sub-tasks: query rewriting, HyDE, history
    // compression, memory extraction, and (optional) LLM contextual retrieval.
    // Override with CHATBOT_FAST_MODEL env var.
    fastModel: process.env.CHATBOT_FAST_MODEL || 'google/gemini-flash-1.5',
  },
  retrieval: {
    topK: parseInt(process.env.CHATBOT_TOP_K, 10) || 5,
    qaHistoryReadLimit: 500,
    chunkMaxChars: 1600,
    candidatePoolK: parseInt(process.env.CHATBOT_CANDIDATE_K, 10) || 20,
    enableHybrid: process.env.CHATBOT_DISABLE_HYBRID !== '1',
    enableReranker: process.env.CHATBOT_DISABLE_RERANKER !== '1',
    rerankerModel: process.env.CHATBOT_RERANKER_MODEL || 'Xenova/ms-marco-MiniLM-L-6-v2',
    helpfulBoost: 1.2,
    unhelpfulSkip: true,
  },
  agent: {
    maxIters: parseInt(process.env.CHATBOT_MAX_ITERS, 10) || 6,
    // 0.1 (was 0.2) ù tighter sampling makes tool-call args more deterministic
    // and reduces stylistic drift between turns. Follow-up generator below
    // stays at 0.5 because it benefits from a bit of variety.
    temperature: 0.1,
    followupModel: process.env.CHATBOT_FOLLOWUP_MODEL || '',
    followupCount: 3,
    // Compress history into a summary when conversation exceeds this many turns.
    historyCompressTurns: parseInt(process.env.CHATBOT_HISTORY_COMPRESS_TURNS, 10) || 8,
    // Hard completion-token budgets fed to OpenRouter as `max_tokens`.
    // pickAnswerBudget() in agent.js picks `verbose` for "full report" /
    // "deep dive" / "everything about" style asks; everything else uses default.
    // Override via env if a tenant needs longer/shorter answers.
    maxTokensDefault: parseInt(process.env.CHATBOT_MAX_TOKENS, 10) || 1200,
    maxTokensVerbose: parseInt(process.env.CHATBOT_MAX_TOKENS_VERBOSE, 10) || 3000,
  },
  features: {
    // Contextual retrieval: prepend document context to each chunk before embedding.
    // 'metadata' = deterministic (free, always-on), 'llm' = LLM-generated context,
    // 'off' = disabled (old behaviour, embed raw chunk text).
    contextualRetrieval: process.env.CHATBOT_CONTEXTUAL_RETRIEVAL || 'metadata',
    // Query rewriting + HyDE: expand the user query into 2 variants + 1 hypothetical
    // document before retrieval. Uses fastModel. Set to '0' to disable.
    queryRewrite: process.env.CHATBOT_DISABLE_QUERY_REWRITE !== '1',
    // Per-user persistent memory: extract facts from conversations and inject them
    // into future system prompts. Set CHATBOT_DISABLE_USER_MEMORY=1 to disable.
    userMemory: process.env.CHATBOT_DISABLE_USER_MEMORY !== '1',
  },
  qaLog: {
    rotateAtLines: 1000,
  },
  toolCache: {
    enabled: process.env.CHATBOT_DISABLE_TOOL_CACHE !== '1',
    file: path.join(__dirname, '.cache', 'tool-cache.json'),
    ttlMs: {
      lookup_person:    60 * 60 * 1000,
      query_copilot:    24 * 60 * 60 * 1000,
      query_cursor:     24 * 60 * 60 * 1000,
      query_jira:       60 * 1000,
      query_jira_issue: 30 * 1000,
      query_github:     60 * 1000,
      query_github_pr:  60 * 1000,
      query_confluence: 5 * 60 * 1000,
      query_testrail:   5 * 60 * 1000,
      query_sprint:     10 * 60 * 1000,
      list_projects:    60 * 60 * 1000,
      list_people:      60 * 60 * 1000,
    },
  },
  watcher: {
    enabled: process.env.CHATBOT_DISABLE_WATCHER !== '1',
    debounceMs: 5000,
  },
  jira: {
    email: process.env.JIRA_EMAIL || '',
    token: process.env.JIRA_TOKEN || '',
    domain: process.env.JIRA_DOMAIN || '',
  },
  github: {
    token: process.env.GITHUB_TOKEN || '',
    org: process.env.ORG || '',
  },
  openRouter: {
    apiKey: process.env.OPENROUTER_API_KEY || '',
    allowInsecureTls: process.env.ALLOW_INSECURE_TLS === '1' || process.env.ALLOW_INSECURE_TLS === 'true',
  },
};
