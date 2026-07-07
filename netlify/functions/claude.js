// ════════════════════════════════════════════════════════════════
// ELEUSYS — /api/claude  v3.0  (Anthropic API proxy)
// V3 CHANGES:
//   · Purpose-scoped token caps — conversation stays lean at 500,
//     document extraction / gap synthesis get the budget they need:
//       chat 500 · extract 3500 · synth 3500 · reftext 2500 · diagnose 800
//   · Origin allowlist (ALLOWED_ORIGINS env) — closes the open-proxy hole
//   · `purpose` is stripped before forwarding (Anthropic rejects unknown params)
// V2 (retained): OPTIONS preflight, body validation, model allowlist,
//   token cap, per-IP rate limiting
// ════════════════════════════════════════════════════════════════

const ALLOWED_MODELS = ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001'];
const PURPOSE_CAPS = { chat: 500, extract: 3500, synth: 3500, reftext: 2500, diagnose: 800 };
const DEFAULT_CAP = 500;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 30;

const rateLimitMap = {};
function getRealIP(event) {
  return (
    event.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    event.headers['client-ip'] ||
    'unknown'
  );
}
function isRateLimited(ip) {
  const now = Date.now();
  if (!rateLimitMap[ip]) { rateLimitMap[ip] = { count: 1, windowStart: now }; return false; }
  const entry = rateLimitMap[ip];
  if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) { entry.count = 1; entry.windowStart = now; return false; }
  entry.count++;
  return entry.count > RATE_LIMIT_MAX;
}

function cors(event) {
  const origin = (event.headers && (event.headers.origin || event.headers.Origin)) || '';
  const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const permitted = !allowed.length || !origin || allowed.includes(origin);
  if (!allowed.length) console.warn('[CLAUDE] ALLOWED_ORIGINS not set — open proxy; set it before launch');
  return {
    permitted,
    headers: {
      'Access-Control-Allow-Origin': allowed.length ? (allowed.includes(origin) ? origin : allowed[0]) : '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Vary': 'Origin'
    }
  };
}

exports.handler = async function (event) {
  const c = cors(event);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: c.headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: c.headers, body: 'Method Not Allowed' };
  if (!c.permitted) {
    console.warn('[CLAUDE] blocked origin:', event.headers.origin);
    return { statusCode: 403, headers: c.headers, body: JSON.stringify({ error: 'Origin not allowed' }) };
  }

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) return { statusCode: 500, headers: c.headers, body: JSON.stringify({ error: 'API key not configured' }) };

  const ip = getRealIP(event);
  if (isRateLimited(ip)) {
    console.warn('[CLAUDE] rate limited:', ip);
    return { statusCode: 429, headers: c.headers, body: JSON.stringify({ error: 'Too many requests — please slow down' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch (e) { return { statusCode: 400, headers: c.headers, body: JSON.stringify({ error: 'Invalid JSON body' }) }; }

  if (!body.model || !ALLOWED_MODELS.includes(body.model)) {
    console.warn('[CLAUDE] blocked model request:', body.model, 'from IP:', ip);
    return { statusCode: 400, headers: c.headers, body: JSON.stringify({ error: 'Model not allowed' }) };
  }

  // Purpose-scoped cap — never trust the client-supplied max_tokens
  const purpose = typeof body.purpose === 'string' ? body.purpose : 'chat';
  const cap = PURPOSE_CAPS[purpose] || DEFAULT_CAP;
  body.max_tokens = Math.min(body.max_tokens || 350, cap);
  delete body.purpose; // Anthropic API rejects unknown top-level params
  console.log('[CLAUDE]', purpose, '→ cap', cap, '| max_tokens', body.max_tokens, '| ip', ip);

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return { statusCode: 400, headers: c.headers, body: JSON.stringify({ error: 'messages array required' }) };
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body)
    });
    const data = await response.json();
    return {
      statusCode: response.status,
      headers: Object.assign({ 'Content-Type': 'application/json' }, c.headers),
      body: JSON.stringify(data)
    };
  } catch (err) {
    console.error('[CLAUDE] Anthropic API error:', err.message);
    return { statusCode: 500, headers: c.headers, body: JSON.stringify({ error: err.message }) };
  }
};
