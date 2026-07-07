// ════════════════════════════════════════════════════════════════
// ELEUSYS — /api/transcribe  v2.0  (Deepgram STT proxy)
// V2 CHANGES:
//   · Content-Type PASSTHROUGH — iOS Safari MediaRecorder produces
//     audio/mp4 (AAC), not webm. v1 hardcoded audio/webm to Deepgram,
//     which only worked because Deepgram sniffs containers. Fragile.
//   · 5.5MB body cap with a clear error (Netlify hard-fails ~6MB —
//     an opaque failure without this guard)
//   · Origin allowlist (ALLOWED_ORIGINS env)
// V1 (retained): nova-2, en-AU, smart_format, base64/binary handling
// ════════════════════════════════════════════════════════════════

const MAX_AUDIO_BYTES = 5.5 * 1024 * 1024;

function cors(event) {
  const origin = (event.headers && (event.headers.origin || event.headers.Origin)) || '';
  const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const permitted = !allowed.length || !origin || allowed.includes(origin);
  return {
    permitted,
    headers: {
      'Access-Control-Allow-Origin': allowed.length ? (allowed.includes(origin) ? origin : allowed[0]) : '*',
      'Access-Control-Allow-Headers': 'Content-Type, Content-Length',
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

  const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
  if (!DEEPGRAM_API_KEY) {
    return {
      statusCode: 500, headers: c.headers,
      body: JSON.stringify({ error: 'Deepgram API key not configured — add DEEPGRAM_API_KEY to Netlify env vars' })
    };
  }

  try {
    // Netlify base64-encodes unrecognised binary content types
    let audioBuffer;
    if (event.isBase64Encoded) {
      audioBuffer = Buffer.from(event.body, 'base64');
    } else {
      audioBuffer = Buffer.from(event.body, 'binary');
    }

    if (!audioBuffer || audioBuffer.length < 100) {
      return { statusCode: 400, headers: c.headers, body: JSON.stringify({ error: 'Audio too short or empty' }) };
    }
    if (audioBuffer.length > MAX_AUDIO_BYTES) {
      console.warn('[TRANSCRIBE] rejected oversize audio:', audioBuffer.length, 'bytes');
      return { statusCode: 413, headers: c.headers, body: JSON.stringify({ error: 'Recording too long — please answer in shorter takes' }) };
    }

    // v2: forward the CLIENT'S container type — iOS sends audio/mp4, Chrome sends audio/webm
    const clientType = (event.headers['content-type'] || event.headers['Content-Type'] || 'audio/webm').split(';')[0].trim();
    const contentType = /^audio\//.test(clientType) ? clientType : 'audio/webm';

    console.log('[TRANSCRIBE] bytes:', audioBuffer.length, '| container:', contentType);

    const dgResponse = await fetch(
      'https://api.deepgram.com/v1/listen?' + new URLSearchParams({
        model: 'nova-2',
        language: 'en-AU',
        smart_format: 'true',
        filler_words: 'false',
        utterances: 'false',
        punctuate: 'true'
      }).toString(),
      {
        method: 'POST',
        headers: {
          'Authorization': `Token ${DEEPGRAM_API_KEY}`,
          'Content-Type': contentType
        },
        body: audioBuffer
      }
    );

    if (!dgResponse.ok) {
      const errText = await dgResponse.text();
      console.error('[TRANSCRIBE] Deepgram error:', dgResponse.status, errText.substring(0, 300));
      return {
        statusCode: dgResponse.status, headers: c.headers,
        body: JSON.stringify({ error: `Deepgram ${dgResponse.status}: ${errText.substring(0, 200)}` })
      };
    }

    const data = await dgResponse.json();
    const transcript = data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
    const confidence = data?.results?.channels?.[0]?.alternatives?.[0]?.confidence || 0;
    console.log('[TRANSCRIBE] transcript:', JSON.stringify(transcript.substring(0, 100)), '| confidence:', confidence);

    return {
      statusCode: 200,
      headers: Object.assign({ 'Content-Type': 'application/json' }, c.headers),
      body: JSON.stringify(data)
    };

  } catch (err) {
    console.error('[TRANSCRIBE] error:', err.message);
    return { statusCode: 500, headers: c.headers, body: JSON.stringify({ error: err.message }) };
  }
};
