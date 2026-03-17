exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
  if (!ELEVENLABS_API_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'ElevenLabs key not configured', hint: 'Check env vars' }) };
  }

  try {
    const body = JSON.parse(event.body);
    const voiceId = body.voiceId || 'UgBBYS2sOqTuMpoF3BR0';
    const text = body.text;

    console.log('TTS request - voiceId:', voiceId, 'text length:', text ? text.length : 0);
    console.log('API key present:', !!ELEVENLABS_API_KEY, 'key starts with:', ELEVENLABS_API_KEY.substring(0,8));

    const response = await fetch('https://api.elevenlabs.io/v1/text-to-speech/' + voiceId, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': ELEVENLABS_API_KEY
      },
      body: JSON.stringify({
        text: text,
        model_id: 'eleven_turbo_v2_5',
        voice_settings: {
          stability: 0.45,
          similarity_boost: 0.75,
          style: 0.35,
          use_speaker_boost: true
        }
      })
    });

    console.log('ElevenLabs response status:', response.status);

    if (!response.ok) {
      const err = await response.text();
      console.log('ElevenLabs error:', err);
      return { statusCode: response.status, body: JSON.stringify({ error: err, status: response.status }) };
    }

    const audioBuffer = await response.arrayBuffer();
    const base64Audio = Buffer.from(audioBuffer).toString('base64');
    console.log('Audio generated, size:', audioBuffer.byteLength);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({ audio: base64Audio })
    };
  } catch (err) {
    console.log('TTS catch error:', err.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
};
