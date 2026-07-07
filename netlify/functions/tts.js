// ════════════════════════════════════════════════════════════════
// ELEUSYS — /api/tts  v2.0  (ElevenLabs proxy — eleven_flash_v2_5)
// V2 CHANGES:
//   · In-memory response cache (voiceId+text → audio+alignment) —
//     the 35 question prompts, section intros, and filler acks are
//     static strings requested by EVERY user; warm-instance hits are
//     free and instant. Works with the client-side cache, not instead.
//   · Origin allowlist (ALLOWED_ORIGINS env)
//   · 2,500-char input cap (Cass never legitimately speaks more)
// V1 (retained): flash model, with-timestamps + fallback endpoint,
//   word-timing builder, voice settings
// ════════════════════════════════════════════════════════════════

const CACHE_MAX = 150;
const _cache = new Map(); // insertion-ordered → FIFO eviction

function cors(event) {
  const origin = (event.headers && (event.headers.origin || event.headers.Origin)) || '';
  const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const permitted = !allowed.length || !origin || allowed.includes(origin);
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
  if (!c.permitted) return { statusCode: 403, headers: c.headers, body: JSON.stringify({ error: 'Origin not allowed' }) };

  const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
  if (!ELEVENLABS_API_KEY) {
    return { statusCode: 500, headers: c.headers, body: JSON.stringify({ error: 'ElevenLabs key not configured' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch (e) { return { statusCode: 400, headers: c.headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const voiceId = body.voiceId || 'UgBBYS2sOqTuMpoF3BR0';
  const text = String(body.text || '').substring(0, 2500);
  if (!text.trim()) {
    return { statusCode: 400, headers: c.headers, body: JSON.stringify({ error: 'No text provided' }) };
  }

  const jsonHeaders = Object.assign({ 'Content-Type': 'application/json' }, c.headers);

  // ── v2: warm-instance cache — free repeat delivery of static lines ──
  const cacheKey = voiceId + '::' + text;
  if (_cache.has(cacheKey)) {
    console.log('[TTS] cache hit | chars:', text.length);
    return { statusCode: 200, headers: jsonHeaders, body: _cache.get(cacheKey) };
  }

  console.log('[TTS] request — model: eleven_flash_v2_5 | chars:', text.length);

  const voiceSettings = {
    stability: 0.75,
    similarity_boost: 0.75,
    style: 0.15,
    use_speaker_boost: true
  };

  function cachePut(payload) {
    _cache.set(cacheKey, payload);
    if (_cache.size > CACHE_MAX) _cache.delete(_cache.keys().next().value);
  }

  try {
    // Primary: with-timestamps endpoint for word sync
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/with-timestamps`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'xi-api-key': ELEVENLABS_API_KEY },
        body: JSON.stringify({
          text,
          model_id: 'eleven_flash_v2_5',
          voice_settings: voiceSettings
        })
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      console.warn('[TTS] with-timestamps failed:', response.status, errText.substring(0, 200));
      // Fallback: standard endpoint, no timings
      const fallback = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'xi-api-key': ELEVENLABS_API_KEY },
          body: JSON.stringify({ text, model_id: 'eleven_flash_v2_5', voice_settings: voiceSettings })
        }
      );
      if (!fallback.ok) {
        return { statusCode: fallback.status, headers: c.headers, body: JSON.stringify({ error: errText.substring(0, 300) }) };
      }
      const buf = await fallback.arrayBuffer();
      const payload = JSON.stringify({ audio: Buffer.from(buf).toString('base64'), alignment: null });
      cachePut(payload);
      return { statusCode: 200, headers: jsonHeaders, body: payload };
    }

    const data = await response.json();

    let wordTimings = null;
    if (data.alignment && data.alignment.characters) {
      wordTimings = buildWordTimings(
        data.alignment.characters,
        data.alignment.character_start_times_seconds,
        data.alignment.character_end_times_seconds
      );
    }

    console.log('[TTS] done — words:', wordTimings ? wordTimings.length : 0);

    const payload = JSON.stringify({ audio: data.audio_base64, alignment: wordTimings });
    cachePut(payload);
    return { statusCode: 200, headers: jsonHeaders, body: payload };

  } catch (err) {
    console.error('[TTS] error:', err.message);
    return { statusCode: 500, headers: c.headers, body: JSON.stringify({ error: err.message }) };
  }
};

function buildWordTimings(chars, startTimes, endTimes) {
  const words = [];
  let wordChars = '';
  let wordStartMs = 0;
  let wordEndMs = 0;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    const st = (startTimes[i] || 0) * 1000;
    const et = (endTimes[i] || st + 50) * 1000;
    if (c === ' ' || c === '\n') {
      if (wordChars.length > 0) {
        words.push({ word: wordChars, startMs: wordStartMs, endMs: wordEndMs });
        wordChars = '';
      }
    } else {
      if (wordChars.length === 0) wordStartMs = st;
      wordChars += c;
      wordEndMs = et;
    }
  }
  if (wordChars.length > 0) words.push({ word: wordChars, startMs: wordStartMs, endMs: wordEndMs });
  return words;
}
