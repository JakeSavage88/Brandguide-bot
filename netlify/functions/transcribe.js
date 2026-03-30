// Netlify function — Deepgram STT proxy for iOS/non-Chrome browsers
// Receives a raw audio blob (webm/opus or webm) from MediaRecorder
// POSTs to Deepgram REST API, returns transcript JSON
// Used as fallback when Web Speech API is unavailable (iOS Safari, Firefox)

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Content-Length',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS_HEADERS, body: 'Method Not Allowed' };
  }

  const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
  if (!DEEPGRAM_API_KEY) {
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Deepgram API key not configured — add DEEPGRAM_API_KEY to Netlify env vars' })
    };
  }

  try {
    // Netlify passes binary body as base64 when isBase64Encoded is true
    // or as raw buffer. Handle both cases.
    let audioBuffer;
    if (event.isBase64Encoded) {
      audioBuffer = Buffer.from(event.body, 'base64');
    } else {
      audioBuffer = Buffer.from(event.body, 'binary');
    }

    if (!audioBuffer || audioBuffer.length < 100) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'Audio too short or empty' })
      };
    }

    console.log('Deepgram transcribe — audio bytes:', audioBuffer.length);

    // Deepgram REST API — prerecorded transcription
    // model: nova-2 (best accuracy/speed balance for short conversational audio)
    // language: en-AU (Australian English — matches the app's target)
    const dgResponse = await fetch(
      'https://api.deepgram.com/v1/listen?' + new URLSearchParams({
        model: 'nova-2',
        language: 'en-AU',
        smart_format: 'true',      // punctuation + casing
        filler_words: 'false',     // remove um/uh
        utterances: 'false',
        punctuate: 'true'
      }).toString(),
      {
        method: 'POST',
        headers: {
          'Authorization': `Token ${DEEPGRAM_API_KEY}`,
          'Content-Type': 'audio/webm',
        },
        body: audioBuffer
      }
    );

    if (!dgResponse.ok) {
      const errText = await dgResponse.text();
      console.error('Deepgram error:', dgResponse.status, errText);
      return {
        statusCode: dgResponse.status,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: `Deepgram ${dgResponse.status}: ${errText}` })
      };
    }

    const data = await dgResponse.json();
    const transcript = data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
    const confidence = data?.results?.channels?.[0]?.alternatives?.[0]?.confidence || 0;

    console.log('Deepgram transcript:', JSON.stringify(transcript.substring(0, 100)), '| confidence:', confidence);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      body: JSON.stringify(data) // return full Deepgram response — frontend parses it
    };

  } catch (err) {
    console.error('Transcribe error:', err.message);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: err.message })
    };
  }
};
