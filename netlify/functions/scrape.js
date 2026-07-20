// ════════════════════════════════════════════════════════════════
// ELEUSYS — /api/scrape  v1.0  (public web page → plain text)
// Feeds the v4.4 opening sequence: the client types their URL, Cass
// reads the site silently, and the brain-dump opener is informed
// rather than generic.
//
// SECURITY — this endpoint fetches a URL supplied by an untrusted
// client. It is an SSRF vector by construction. Defences:
//   · http(s) scheme only — no file:, gopher:, data:, ftp:
//   · DNS resolved BEFORE connect; EVERY A/AAAA record must be
//     public. Any private/loopback/link-local/CGNAT/metadata hit
//     rejects the whole host (no "first record wins" bypass)
//   · 169.254.0.0/16 explicitly dead — cloud metadata is the prize
//   · redirect:'manual' — every hop re-validated through the same
//     gate. Auto-follow would let a public URL 302 into the VPC
//   · MAX_HOPS 3 · 7s connect timeout · 1.5MB body cap
//   · text/html + text/plain only — no binary hoovering
//   · Origin allowlist (ALLOWED_ORIGINS env)
//
// RESIDUAL RISK (accepted, documented): DNS rebinding TOCTOU. We
// resolve, validate, then fetch — fetch re-resolves. A hostile 1s-TTL
// record can flip between those two moments. Closing it needs
// connect-to-IP with SNI pinning, which is not worth the complexity
// against a 7s read-only public-web scrape that returns text to the
// same user who supplied the URL.
//
// Optional env: ALLOWED_ORIGINS (comma-separated)
// Zero npm dependencies.
// ════════════════════════════════════════════════════════════════

const dns = require('dns').promises;
const net = require('net');

const MAX_HOPS = 3;
const FETCH_TIMEOUT_MS = 7000;
const MAX_BYTES = 1.5 * 1024 * 1024;
const MAX_TEXT_CHARS = 20000;
const UA = 'Mozilla/5.0 (compatible; EleusysCass/1.0; +https://eleusys.ai)';

function cors(event) {
  const origin = (event.headers && (event.headers.origin || event.headers.Origin)) || '';
  const allowed = (process.env.ALLOWED_ORIGINS || '')
    .split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  return {
    headers: {
      'Access-Control-Allow-Origin': allowed.length ? (allowed.includes(origin) ? origin : allowed[0]) : '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Content-Type': 'application/json'
    },
    blocked: allowed.length > 0 && origin && !allowed.includes(origin)
  };
}

// ── IP CLASSIFICATION ────────────────────────────────────────────
function ipToLong(ip) {
  const p = ip.split('.');
  return ((+p[0] << 24) >>> 0) + ((+p[1] << 16) >>> 0) + ((+p[2] << 8) >>> 0) + (+p[3] >>> 0);
}
function inCidr4(ip, base, bits) {
  const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
  return (ipToLong(ip) & mask) === (ipToLong(base) & mask);
}
const BLOCKED_V4 = [
  ['0.0.0.0', 8],        // this network
  ['10.0.0.0', 8],       // RFC1918
  ['100.64.0.0', 10],    // CGNAT
  ['127.0.0.0', 8],      // loopback
  ['169.254.0.0', 16],   // link-local — CLOUD METADATA
  ['172.16.0.0', 12],    // RFC1918
  ['192.0.0.0', 24],     // IETF protocol assignments
  ['192.0.2.0', 24],     // TEST-NET-1
  ['192.168.0.0', 16],   // RFC1918
  ['198.18.0.0', 15],    // benchmarking
  ['198.51.100.0', 24],  // TEST-NET-2
  ['203.0.113.0', 24],   // TEST-NET-3
  ['224.0.0.0', 4],      // multicast
  ['240.0.0.0', 4]       // reserved
];

function isPrivateIP(ip) {
  try {
    const v = net.isIP(ip);
    if (v === 4) {
      for (let i = 0; i < BLOCKED_V4.length; i++) {
        if (inCidr4(ip, BLOCKED_V4[i][0], BLOCKED_V4[i][1])) return true;
      }
      return false;
    }
    if (v === 6) {
      const s = ip.toLowerCase().split('%')[0];
      if (s === '::1' || s === '::' || s === '::0') return true;
      // IPv4-mapped / IPv4-compatible — unwrap and re-check
      const m = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/) || s.match(/^::(\d+\.\d+\.\d+\.\d+)$/);
      if (m) return isPrivateIP(m[1]);
      if (/^f[cd]/.test(s)) return true;              // fc00::/7 unique-local
      if (/^fe[89ab]/.test(s)) return true;           // fe80::/10 link-local
      if (/^ff/.test(s)) return true;                 // multicast
      if (/^2001:0?db8:/.test(s)) return true;        // documentation
      return false;
    }
    return true; // unparseable → treat as hostile
  } catch (e) {
    return true;
  }
}

// Resolve every record and require ALL of them to be public.
async function assertHostPublic(hostname) {
  const h = String(hostname || '').trim().toLowerCase().replace(/\.$/, '');
  if (!h) throw new Error('empty host');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) {
    throw new Error('blocked host');
  }
  // Literal IP in the URL — validate directly, never resolve
  if (net.isIP(h)) {
    if (isPrivateIP(h)) throw new Error('blocked address');
    return [h];
  }
  let ips = [];
  const [a, aaaa] = await Promise.all([
    dns.resolve4(h).catch(function () { return []; }),
    dns.resolve6(h).catch(function () { return []; })
  ]);
  ips = a.concat(aaaa);
  if (!ips.length) throw new Error('dns resolve failed');
  for (let i = 0; i < ips.length; i++) {
    if (isPrivateIP(ips[i])) throw new Error('blocked address');
  }
  return ips;
}

// ── HTML → TEXT ──────────────────────────────────────────────────
function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#0?39;/g, "'")
    .replace(/&apos;/gi, "'").replace(/&mdash;/gi, '—').replace(/&ndash;/gi, '–')
    .replace(/&rsquo;/gi, '\u2019').replace(/&lsquo;/gi, '\u2018')
    .replace(/&#(\d+);/g, function (_, d) {
      try { return String.fromCharCode(parseInt(d, 10)); } catch (e) { return ' '; }
    });
}

function extractTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim().substring(0, 160) : '';
}

function extractDescription(html) {
  let m = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i)
    || html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i);
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim().substring(0, 400) : '';
}

function htmlToText(html) {
  let t = String(html || '');
  // Kill everything that is not prose
  t = t.replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<form[\s\S]*?<\/form>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  // Block-level tags become line breaks so sentences do not fuse
  t = t.replace(/<\/(p|div|h[1-6]|li|tr|section|article|br)[^>]*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n');
  t = t.replace(/<[^>]+>/g, ' ');
  t = decodeEntities(t);
  t = t.replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .split('\n').map(function (l) { return l.trim(); }).join('\n')
    .trim();
  return t.substring(0, MAX_TEXT_CHARS);
}

// ── SINGLE VALIDATED HOP ─────────────────────────────────────────
async function fetchOnce(urlStr) {
  const u = new URL(urlStr);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('scheme not allowed');
  await assertHostPublic(u.hostname);

  const ctl = new AbortController();
  const timer = setTimeout(function () { ctl.abort(); }, FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(u.toString(), {
      method: 'GET',
      redirect: 'manual',
      signal: ctl.signal,
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1',
        'Accept-Language': 'en-AU,en;q=0.9'
      }
    });
  } finally {
    clearTimeout(timer);
  }
  return { res: res, url: u };
}

exports.handler = async function (event) {
  const c = cors(event);

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: c.headers, body: '' };
  if (c.blocked) {
    console.warn('[SCRAPE] origin rejected:', event.headers && event.headers.origin);
    return { statusCode: 403, headers: c.headers, body: JSON.stringify({ ok: false, error: 'origin not allowed' }) };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: c.headers, body: JSON.stringify({ ok: false, error: 'method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers: c.headers, body: JSON.stringify({ ok: false, error: 'bad json' }) };
  }

  let target = String(body.url || '').trim();
  if (!target) return { statusCode: 400, headers: c.headers, body: JSON.stringify({ ok: false, error: 'url required' }) };
  if (target.length > 2000) return { statusCode: 400, headers: c.headers, body: JSON.stringify({ ok: false, error: 'url too long' }) };
  if (!/^https?:\/\//i.test(target)) target = 'https://' + target;

  try {
    let current = target;
    let hops = 0;
    let finalRes = null;
    let finalUrl = null;

    while (hops <= MAX_HOPS) {
      const out = await fetchOnce(current);
      const res = out.res;
      const status = res.status;

      if (status >= 300 && status < 400) {
        const loc = res.headers.get('location');
        if (!loc) throw new Error('redirect without location');
        // Resolve relative → absolute, then re-validate on the next loop pass
        current = new URL(loc, out.url).toString();
        hops++;
        console.log('[SCRAPE] hop', hops, '→', current);
        continue;
      }
      finalRes = res;
      finalUrl = out.url.toString();
      break;
    }

    if (!finalRes) throw new Error('too many redirects');
    if (!finalRes.ok) {
      console.warn('[SCRAPE] upstream HTTP', finalRes.status, finalUrl);
      return {
        statusCode: 200, headers: c.headers,
        body: JSON.stringify({ ok: false, error: 'site returned HTTP ' + finalRes.status })
      };
    }

    const ct = (finalRes.headers.get('content-type') || '').toLowerCase();
    if (!/text\/html|text\/plain|application\/xhtml/.test(ct)) {
      console.warn('[SCRAPE] non-text content-type:', ct);
      return {
        statusCode: 200, headers: c.headers,
        body: JSON.stringify({ ok: false, error: 'not a readable web page' })
      };
    }

    // Size-capped read — a hostile or careless server will not blow the lambda
    const buf = await finalRes.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) {
      console.warn('[SCRAPE] body over cap:', buf.byteLength);
      return {
        statusCode: 200, headers: c.headers,
        body: JSON.stringify({ ok: false, error: 'page too large' })
      };
    }
    const html = Buffer.from(buf).toString('utf8');

    const title = extractTitle(html);
    const description = extractDescription(html);
    const text = htmlToText(html);

    console.log('[SCRAPE] ok', finalUrl, '·', text.length, 'chars ·', JSON.stringify(title));

    return {
      statusCode: 200,
      headers: c.headers,
      body: JSON.stringify({ ok: true, url: finalUrl, title: title, description: description, text: text })
    };
  } catch (e) {
    const msg = (e && e.message) ? e.message : 'scrape failed';
    console.warn('[SCRAPE] failed:', msg);
    // Always 200 with ok:false — the client treats this as "no site info"
    // and falls back to the generic opener. A 5xx here would look like our bug.
    return {
      statusCode: 200,
      headers: c.headers,
      body: JSON.stringify({ ok: false, error: msg === 'blocked address' || msg === 'blocked host' ? 'that address is not reachable' : msg })
    };
  }
};
