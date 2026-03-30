// Netlify function — ElevenLabs TTS proxy
// eleven_flash_v2_5: fastest model, ~300ms generation vs ~800ms on turbo
// Returns base64 audio + word-level alignment timings

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS_HEADERS, body: 'Method Not Allowed' };
  }

  const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
  if (!ELEVENLABS_API_KEY) {
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'ElevenLabs key not configured' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch(e) { return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const voiceId = body.voiceId || 'UgBBYS2sOqTuMpoF3BR0';
  const text = body.text;
  if (!text || !text.trim()) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'No text provided' }) };
  }

  console.log('TTS request — model: eleven_flash_v2_5 | chars:', text.length);

  const voiceSettings = {
    stability: 0.75,
    similarity_boost: 0.75,
    style: 0.15,
    use_speaker_boost: true
  };

  try {
    // Primary: with-timestamps endpoint for word sync
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/with-timestamps`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'xi-api-key': ELEVENLABS_API_KEY },
        body: JSON.stringify({
          text,
          model_id: 'eleven_flash_v2_5',   // fastest model — ~300ms vs ~800ms on turbo
          voice_settings: voiceSettings
        })
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      console.warn('with-timestamps failed:', response.status, errText);
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
        return { statusCode: fallback.status, headers: CORS_HEADERS, body: JSON.stringify({ error: errText }) };
      }
      const buf = await fallback.arrayBuffer();
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        body: JSON.stringify({ audio: Buffer.from(buf).toString('base64'), alignment: null })
      };
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

    console.log('TTS done — words:', wordTimings ? wordTimings.length : 0);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      body: JSON.stringify({ audio: data.audio_base64, alignment: wordTimings })
    };

  } catch (err) {
    console.error('TTS error:', err.message);
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: err.message }) };
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
