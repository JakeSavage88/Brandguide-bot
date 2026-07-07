// ════════════════════════════════════════════════════════════════
// ELEUSYS — /api/session  v1.0
// Server-side session persistence → "Sessions" tab in the same Sheet.
// Solves: Safari 7-day localStorage eviction, cross-device resume,
// multi-day pauses. One row per sessionId, upserted.
//   GET  /api/session?id=<sessionId>  → {found, expired, cs, cq, answers, ...}
//   POST /api/session {id, tier, cs, cq, email, answers, prefilled, confirmed, synth}
// Retention: SESSION_TTL_DAYS (default 30) — expired sessions return {expired:true}.
// Required env: GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY, SHEET_ID
// Optional env: ALLOWED_ORIGINS, SESSIONS_TAB (default "Sessions"), SESSION_TTL_DAYS
// ════════════════════════════════════════════════════════════════

const crypto = require('crypto');

const SESSIONS_TAB = process.env.SESSIONS_TAB || 'Sessions';
const TTL_DAYS = parseInt(process.env.SESSION_TTL_DAYS || '30', 10);
const HEADER = ['SessionID', 'Email', 'Tier', 'UpdatedAt', 'CS', 'CQ', 'AnswersJSON', 'PrefilledJSON', 'ConfirmedJSON', 'SynthJSON'];

function cors(event) {
  const origin = (event.headers && (event.headers.origin || event.headers.Origin)) || '';
  const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const permitted = !allowed.length || !origin || allowed.includes(origin);
  return {
    permitted,
    headers: {
      'Access-Control-Allow-Origin': allowed.length ? (allowed.includes(origin) ? origin : allowed[0]) : '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Vary': 'Origin'
    }
  };
}

let _tok = { t: null, exp: 0 };
async function getAccessToken() {
  if (_tok.t && Date.now() < _tok.exp - 60000) return _tok.t;
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  let key = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!email || !key) throw new Error('Google service account env vars not configured');
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

const SHEET_ID = process.env.SHEET_ID;
const BASE = () => `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}`;
async function sheetsFetch(tok, url, opts) {
  const r = await fetch(url, Object.assign({ headers: { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json' } }, opts || {}));
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Sheets ' + r.status + ': ' + (d.error && d.error.message || '').substring(0, 200));
  return d;
}

let _ensured = false;
async function ensureTab(tok) {
  if (_ensured) return;
  const meta = await sheetsFetch(tok, BASE() + '?fields=sheets.properties.title');
  const titles = (meta.sheets || []).map(s => s.properties.title);
  if (!titles.includes(SESSIONS_TAB)) {
    console.log('[SESSION] creating tab:', SESSIONS_TAB);
    await sheetsFetch(tok, BASE() + ':batchUpdate', {
      method: 'POST', body: JSON.stringify({ requests: [{ addSheet: { properties: { title: SESSIONS_TAB } } }] })
    });
  }
  const head = await sheetsFetch(tok, BASE() + `/values/${encodeURIComponent(SESSIONS_TAB + '!A1:A1')}`);
  if (!head.values || !head.values.length) {
    await sheetsFetch(tok, BASE() + `/values/${encodeURIComponent(SESSIONS_TAB + '!A1')}?valueInputOption=RAW`, {
      method: 'PUT', body: JSON.stringify({ values: [HEADER] })
    });
  }
  _ensured = true;
}

async function findRow(tok, id) {
  const ids = await sheetsFetch(tok, BASE() + `/values/${encodeURIComponent(SESSIONS_TAB + '!A2:A')}`);
  let rowNum = null;
  (ids.values || []).forEach((r, i) => { if (r[0] === id) rowNum = i + 2; });
  return rowNum;
}
const safeParse = (s, fb) => { try { return JSON.parse(s); } catch (e) { return fb; } };

exports.handler = async function (event) {
  const c = cors(event);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: c.headers, body: '' };
  if (!c.permitted) return { statusCode: 403, headers: c.headers, body: JSON.stringify({ error: 'Origin not allowed' }) };
  if (!SHEET_ID) return { statusCode: 500, headers: c.headers, body: JSON.stringify({ error: 'SHEET_ID not configured' }) };
  const jsonHeaders = Object.assign({ 'Content-Type': 'application/json' }, c.headers);

  try {
    // ── GET: fetch a session ──
    if (event.httpMethod === 'GET') {
      const id = (event.queryStringParameters || {}).id || '';
      if (!/^[A-Za-z0-9-]{8,64}$/.test(id))
        return { statusCode: 400, headers: jsonHeaders, body: JSON.stringify({ error: 'Valid id required' }) };
      const tok = await getAccessToken();
      await ensureTab(tok);
      const rowNum = await findRow(tok, id);
      if (!rowNum) return { statusCode: 200, headers: jsonHeaders, body: JSON.stringify({ found: false }) };
      const d = await sheetsFetch(tok, BASE() + `/values/${encodeURIComponent(SESSIONS_TAB + '!A' + rowNum + ':J' + rowNum)}`);
      const r = (d.values && d.values[0]) || [];
      const ts = Date.parse(r[3] || '') || 0;
      const expired = TTL_DAYS > 0 && ts > 0 && (Date.now() - ts) > TTL_DAYS * 86400000;
      console.log('[SESSION] fetched', id, expired ? '(expired)' : '', '—', ts ? new Date(ts).toISOString() : 'no-ts');
      return {
        statusCode: 200, headers: jsonHeaders,
        body: JSON.stringify({
          found: true, expired,
          email: r[1] || '', tier: r[2] || '', ts,
          cs: parseInt(r[4] || '0', 10) || 0, cq: parseInt(r[5] || '0', 10) || 0,
          answers: safeParse(r[6], {}), prefilled: safeParse(r[7], {}),
          confirmed: safeParse(r[8], {}), synth: safeParse(r[9], {})
        })
      };
    }

    // ── POST: upsert a session snapshot ──
    if (event.httpMethod === 'POST') {
      let body;
      try { body = JSON.parse(event.body); }
      catch (e) { return { statusCode: 400, headers: jsonHeaders, body: JSON.stringify({ error: 'Invalid JSON' }) }; }
      const id = String(body.id || '').trim();
      if (!/^[A-Za-z0-9-]{8,64}$/.test(id))
        return { statusCode: 400, headers: jsonHeaders, body: JSON.stringify({ error: 'Valid id required' }) };
      const cap = (o) => { const s = JSON.stringify(o || {}); return s.length > 45000 ? '{}' : s; }; // cell cap guard
      const row = [
        id,
        String(body.email || '').substring(0, 200),
        String(body.tier || '').substring(0, 20),
        new Date().toISOString(),
        String(parseInt(body.cs || 0, 10)),
        String(parseInt(body.cq || 0, 10)),
        cap(body.answers), cap(body.prefilled), cap(body.confirmed), cap(body.synth)
      ];
      const tok = await getAccessToken();
      await ensureTab(tok);
      const rowNum = await findRow(tok, id);
      if (rowNum) {
        await sheetsFetch(tok, BASE() + `/values/${encodeURIComponent(SESSIONS_TAB + '!A' + rowNum + ':J' + rowNum)}?valueInputOption=RAW`, {
          method: 'PUT', body: JSON.stringify({ values: [row] })
        });
      } else {
        await sheetsFetch(tok, BASE() + `/values/${encodeURIComponent(SESSIONS_TAB + '!A1')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
          method: 'POST', body: JSON.stringify({ values: [row] })
        });
      }
      console.log('[SESSION] upserted', id, '—', Object.keys(body.answers || {}).length, 'answers');
      return { statusCode: 200, headers: jsonHeaders, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 405, headers: jsonHeaders, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  } catch (err) {
    console.error('[SESSION] FAILED:', err.message);
    return { statusCode: 502, headers: jsonHeaders, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
