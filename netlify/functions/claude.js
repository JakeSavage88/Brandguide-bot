// Netlify serverless function — Anthropic API proxy
// V2: OPTIONS preflight, body validation, model allowlist, token cap, rate limiting

const ALLOWED_MODELS = ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001'];
const MAX_TOKENS_CAP = 2000; // Never allow more than this — protects against abuse
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 30; // max requests per IP per minute

// Simple in-memory rate limiter (resets on function cold start — good enough for Netlify)
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
  if (!rateLimitMap[ip]) {
    rateLimitMap[ip] = { count: 1, windowStart: now };
    return false;
  }
  const entry = rateLimitMap[ip];
  if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    // New window
    entry.count = 1;
    entry.windowStart = now;
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT_MAX;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

exports.handler = async function(event) {
  // Handle OPTIONS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS_HEADERS, body: 'Method Not Allowed' };
  }

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) {
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'API key not configured' }) };
  }

  // Rate limiting
  const ip = getRealIP(event);
  if (isRateLimited(ip)) {
    console.warn('Rate limited:', ip);
    return { statusCode: 429, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Too many requests — please slow down' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  // Validate model
  if (!body.model || !ALLOWED_MODELS.includes(body.model)) {
    console.warn('Blocked model request:', body.model, 'from IP:', ip);
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Model not allowed' }) };
  }

  // Enforce max_tokens cap — never trust client-supplied value
  body.max_tokens = Math.min(body.max_tokens || 350, MAX_TOKENS_CAP);

  // Validate messages array exists
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'messages array required' }) };
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
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      body: JSON.stringify(data)
    };
  } catch (err) {
    console.error('Anthropic API error:', err.message);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: err.message })
    };
  }
};
