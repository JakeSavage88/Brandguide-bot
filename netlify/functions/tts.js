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

  const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
  if (!ELEVENLABS_API_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'ElevenLabs key not configured' }) };
  }

  try {
    const body = JSON.parse(event.body);
    const voiceId = body.voiceId || 'UgBBYS2sOqTuMpoF3BR0';
    const text = body.text;

    console.log('TTS request - voiceId:', voiceId, 'text length:', text ? text.length : 0);

    // Use the with-timestamps endpoint for word-level sync
    const response = await fetch(
      'https://api.elevenlabs.io/v1/text-to-speech/' + voiceId + '/with-timestamps',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': ELEVENLABS_API_KEY
        },
        body: JSON.stringify({
          text: text,
          model_id: 'eleven_turbo_v2_5',
          voice_settings: {
            stability: 0.75,      // higher = fewer hallucinated words
            similarity_boost: 0.75,
            style: 0.15,          // lower = more stable, less expressive artefacts
            use_speaker_boost: true
          }
        })
      }
    );

    console.log('ElevenLabs response status:', response.status);

    if (!response.ok) {
      const err = await response.text();
      console.log('ElevenLabs error:', err);
      // Fall back to standard endpoint if with-timestamps fails
      const fallback = await fetch(
        'https://api.elevenlabs.io/v1/text-to-speech/' + voiceId,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'xi-api-key': ELEVENLABS_API_KEY
          },
          body: JSON.stringify({
            text: text,
            model_id: 'eleven_turbo_v2_5',
            voice_settings: {
              stability: 0.75,
              similarity_boost: 0.75,
              style: 0.15,
              use_speaker_boost: true
            }
          })
        }
      );
      if (!fallback.ok) {
        return { statusCode: fallback.status, headers: CORS_HEADERS, body: JSON.stringify({ error: err }) };
      }
      const audioBuffer = await fallback.arrayBuffer();
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        body: JSON.stringify({ audio: Buffer.from(audioBuffer).toString('base64'), alignment: null })
      };
    }

    // with-timestamps returns JSON: { audio_base64, alignment: { characters, character_start_times_seconds, character_end_times_seconds } }
    const data = await response.json();

    // Convert character-level alignment to word-level for the frontend
    // alignment.characters = array of chars, alignment.character_start_times_seconds = array of start times
    let wordTimings = null;
    if (data.alignment && data.alignment.characters) {
      wordTimings = buildWordTimings(
        text,
        data.alignment.characters,
        data.alignment.character_start_times_seconds,
        data.alignment.character_end_times_seconds
      );
    }

    console.log('Audio generated, word timings:', wordTimings ? wordTimings.length + ' words' : 'none');

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      body: JSON.stringify({
        audio: data.audio_base64,
        alignment: wordTimings
      })
    };

  } catch (err) {
    console.log('TTS catch error:', err.message);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: err.message })
    };
  }
};

// Convert ElevenLabs character-level alignment to word-level timings
// Returns: [{ word, startMs, endMs }, ...]
function buildWordTimings(text, chars, startTimes, endTimes) {
  const words = [];
  let wordStart = null;
  let wordChars = '';
  let wordStartMs = 0;
  let wordEndMs = 0;
  let charIdx = 0;

  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    const st = (startTimes[i] || 0) * 1000; // convert to ms
    const et = (endTimes[i] || st + 50) * 1000;

    if (c === ' ' || c === '\n') {
      if (wordChars.length > 0) {
        words.push({ word: wordChars, startMs: wordStartMs, endMs: wordEndMs });
        wordChars = '';
        wordStart = null;
      }
    } else {
      if (wordChars.length === 0) {
        wordStartMs = st;
      }
      wordChars += c;
      wordEndMs = et;
    }
  }
  // Last word
  if (wordChars.length > 0) {
    words.push({ word: wordChars, startMs: wordStartMs, endMs: wordEndMs });
  }
  return words;
}
