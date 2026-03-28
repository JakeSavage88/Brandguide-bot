// Netlify serverless function — serves Vapi config to frontend
// Keys live in Netlify environment variables, never in frontend code

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS'
};

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS_HEADERS, body: 'Method Not Allowed' };
  }

  const VAPI_PUBLIC_KEY = process.env.VAPI_PUBLIC_KEY;
  const VAPI_ASSISTANT_ID = process.env.VAPI_ASSISTANT_ID;

  if (!VAPI_PUBLIC_KEY || !VAPI_ASSISTANT_ID) {
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Vapi config not set in environment variables' })
    };
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    body: JSON.stringify({
      publicKey: VAPI_PUBLIC_KEY,
      assistantId: VAPI_ASSISTANT_ID
    })
  };
};
