// ════════════════════════════════════════════════════════════════
// ELEUSYS — /api/submit  v1.1  (Intake Data Contract v2.0 LOCKED)
// v1.1: SourceMap provenance column · Contract version column ·
//       hard validation (email + Business / Brand Name) ·
//       tier enum oracle|seer|spark with permanent legacy aliases
// Verifiable, idempotent brief submission → Google Sheets API.
// Replaces the fire-and-forget Google Form POST entirely.
//   · One row per sessionId, UPSERTED (retries can never duplicate)
//   · Status column written atomically → n8n SW1 gates on COMPLETE
//   · Unknown answer keys land in the Extra column (schema-drift-proof)
//   · Zero npm dependencies — JWT signed with Node crypto
// Required env: GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY, SHEET_ID
// Optional env: ALLOWED_ORIGINS (comma-separated), INTAKE_TAB (default "Intake")
// ════════════════════════════════════════════════════════════════

const crypto = require('crypto');

const INTAKE_TAB = process.env.INTAKE_TAB || 'Intake';

// Column contract — MUST match the front-end question keys (q.k) exactly.
// n8n SW1 maps by these header names. Change here + SW1 together, never one side.
const FIELD_ORDER = [
  'Business / Brand Name','Website URL','Business / Brand Mission','Business / Brand Vision',
  'Brand Promise / Value Proposition','Tagline / Slogan (if any)','Brand Story & History',
  'Founder / Leadership Perspective',
  'Target Audience / Customer Personas','Customer Pain Points','Customer Journey / Key Touchpoints',
  'Market Positioning','Market Segment / Industry',
  'Primary Competitors','Competitive Advantage / Differentiation','SWOT Notes',
  'Brand Personality','Brand Values','Tone of Voice','Visual Style / Brand Aesthetic Notes',
  'Colour Palette & Typography Preferences',
  'Key Products or Services','Product / Service Unique Mechanics','Features & Benefits',
  'Pricing Strategy','Customer Experience Overview',
  'Current Marketing Channels','Core Messaging Pillars','Key Messages / Elevator Pitch',
  'Brand Goals & Objectives','Channel-specific Messaging / Tone Notes',
  'Challenges & Barriers','Inspirations / References','Brand Archetype / Personality Archetype',
  'Notes / Special Request'
];
const HEADER = ['Timestamp','SessionID','Status','Tier','Email']
  .concat(FIELD_ORDER)
  .concat(['SourceMap','Synthesized','Degraded','Extra','Contract','Source']);
const TIERS = { oracle:'oracle', seer:'seer', spark:'spark',
  // permanent legacy aliases — early links never break
  premium:'oracle', accelerated:'seer', express:'spark' };

// ── CORS / origin allowlist ───────────────────────────────────────
function cors(event) {
  const origin = (event.headers && (event.headers.origin || event.headers.Origin)) || '';
  const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const permitted = !allowed.length || !origin || allowed.includes(origin);
  if (!allowed.length) console.warn('[SUBMIT] ALLOWED_ORIGINS not set — allowing all origins (set it before launch)');
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

// ── Google service-account auth (zero-dep JWT, in-memory token cache) ──
let _tok = { t: null, exp: 0 };
async function getAccessToken() {
  if (_tok.t && Date.now() < _tok.exp - 60000) return _tok.t;
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  let key = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'); // Netlify env paste normaliser
  if (!email || !key) throw new Error('GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_PRIVATE_KEY not configured');
  const now = Math.floor(Date.now() / 1000);
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = b64({ alg: 'RS256', typ: 'JWT' }) + '.' + b64({
    iss: email, scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600
  });
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(key, 'base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + (unsigned + '.' + sig)
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('Google token exchange failed: ' + JSON.stringify(d).substring(0, 300));
  _tok = { t: d.access_token, exp: Date.now() + (d.expires_in || 3600) * 1000 };
  return _tok.t;
}

// ── Sheets REST helpers ───────────────────────────────────────────
const SHEET_ID = process.env.SHEET_ID;
const BASE = () => `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}`;

async function sheetsFetch(tok, url, opts) {
  const r = await fetch(url, Object.assign({ headers: { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json' } }, opts || {}));
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Sheets ' + r.status + ': ' + (d.error && d.error.message || JSON.stringify(d).substring(0, 200)));
  return d;
}
function colLetter(n) { // 1-indexed → A1 letter
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

let _ensured = false;
async function ensureIntakeTab(tok) {
  if (_ensured) return;
  const meta = await sheetsFetch(tok, BASE() + '?fields=sheets.properties.title');
  const titles = (meta.sheets || []).map(s => s.properties.title);
  if (!titles.includes(INTAKE_TAB)) {
    console.log('[SUBMIT] creating tab:', INTAKE_TAB);
    await sheetsFetch(tok, BASE() + ':batchUpdate', {
      method: 'POST',
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: INTAKE_TAB } } }] })
    });
  }
  const head = await sheetsFetch(tok, BASE() + `/values/${encodeURIComponent(INTAKE_TAB + '!A1:A1')}`);
  if (!head.values || !head.values.length) {
    console.log('[SUBMIT] writing header row —', HEADER.length, 'columns');
    await sheetsFetch(tok, BASE() + `/values/${encodeURIComponent(INTAKE_TAB + '!A1')}?valueInputOption=RAW`, {
      method: 'PUT',
      body: JSON.stringify({ values: [HEADER] })
    });
  }
  _ensured = true;
}

exports.handler = async function (event) {
  const c = cors(event);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: c.headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: c.headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  if (!c.permitted) return { statusCode: 403, headers: c.headers, body: JSON.stringify({ error: 'Origin not allowed' }) };
  if (!SHEET_ID) return { statusCode: 500, headers: c.headers, body: JSON.stringify({ error: 'SHEET_ID not configured' }) };

  let body;
  try { body = JSON.parse(event.body); }
  catch (e) { return { statusCode: 400, headers: c.headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const sessionId = String(body.sessionId || '').trim();
  const answers = body.answers || {};
  if (!sessionId || !/^[A-Za-z0-9-]{8,64}$/.test(sessionId))
    return { statusCode: 400, headers: c.headers, body: JSON.stringify({ error: 'Valid sessionId required' }) };
  if (!Object.keys(answers).length)
    return { statusCode: 400, headers: c.headers, body: JSON.stringify({ error: 'answers required' }) };

  // Contract v2.0 §7 hard minimums — a brief without these is unprocessable downstream
  const email = String(body.email || answers['Contact Email'] || '').toLowerCase().trim();
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email))
    return { statusCode: 400, headers: c.headers, body: JSON.stringify({ error: 'Valid email required (Contact Email)' }) };
  if (!String(answers['Business / Brand Name'] || '').trim())
    return { statusCode: 400, headers: c.headers, body: JSON.stringify({ error: 'Business / Brand Name required' }) };
  const tier = TIERS[String(body.tier || '').toLowerCase()] || 'oracle';
  if (!TIERS[String(body.tier || '').toLowerCase()]) console.warn('[SUBMIT] unknown tier "' + body.tier + '" — defaulting to oracle');

  try {
    const tok = await getAccessToken();
    await ensureIntakeTab(tok);

    // Build the row against the fixed contract; anything unrecognised → Extra column
    const known = new Set(FIELD_ORDER.concat(['Contact Email']));
    const extra = {};
    Object.keys(answers).forEach(k => { if (!known.has(k)) extra[k] = answers[k]; });
    if (Object.keys(extra).length) console.warn('[SUBMIT] unknown keys → Extra column:', Object.keys(extra).join(', '));

    const clean = v => String(v == null ? '' : v).substring(0, 4500); // stay well under 50k cell cap
    const capJson = o => { const j = JSON.stringify(o || {}); return j.length > 45000 ? '{}' : j; };
    const sourceMap = body.sourceMap && typeof body.sourceMap === 'object' ? body.sourceMap : {};
    const synthesized = Array.isArray(body.synthesized) && body.synthesized.length
      ? body.synthesized
      : Object.keys(sourceMap).filter(k => sourceMap[k] === 'synthesized');
    const row = [
      new Date().toISOString(),
      sessionId,
      'COMPLETE',
      tier,
      clean(email)
    ]
      .concat(FIELD_ORDER.map(k => clean(answers[k])))
      .concat([
        capJson(sourceMap),
        JSON.stringify(synthesized),
        JSON.stringify(body.degraded || []),
        Object.keys(extra).length ? capJson(extra) : '',
        String(body.contract || 'v2.0'),
        clean(body.v || 'cass-v4')
      ]);

    // Idempotent upsert — find existing row for this sessionId
    const ids = await sheetsFetch(tok, BASE() + `/values/${encodeURIComponent(INTAKE_TAB + '!B2:B')}`);
    let rowNum = null;
    (ids.values || []).forEach((r, i) => { if (r[0] === sessionId) rowNum = i + 2; });

    const endCol = colLetter(row.length);
    if (rowNum) {
      console.log('[SUBMIT] upsert — updating existing row', rowNum, 'for', sessionId);
      await sheetsFetch(tok, BASE() + `/values/${encodeURIComponent(INTAKE_TAB + '!A' + rowNum + ':' + endCol + rowNum)}?valueInputOption=RAW`, {
        method: 'PUT', body: JSON.stringify({ values: [row] })
      });
    } else {
      console.log('[SUBMIT] appending new row for', sessionId);
      const ap = await sheetsFetch(tok, BASE() + `/values/${encodeURIComponent(INTAKE_TAB + '!A1')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
        method: 'POST', body: JSON.stringify({ values: [row] })
      });
      const m = (ap.updates && ap.updates.updatedRange || '').match(/!A(\d+)/);
      rowNum = m ? parseInt(m[1], 10) : null;
    }

    const ref = 'ELEU-' + sessionId.replace(/-/g, '').substring(0, 8).toUpperCase();
    console.log('[SUBMIT] delivered — row', rowNum, 'ref', ref, 'fields', FIELD_ORDER.filter(k => answers[k]).length + '/' + FIELD_ORDER.length);
    return { statusCode: 200, headers: Object.assign({ 'Content-Type': 'application/json' }, c.headers), body: JSON.stringify({ ok: true, ref, row: rowNum }) };

  } catch (err) {
    console.error('[SUBMIT] FAILED:', err.message);
    return { statusCode: 502, headers: c.headers, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
