const WebSocket = require('ws');
require('dotenv').config({ path: '.env.local' });

const key = process.env.NEXT_PUBLIC_GEMINI_API_KEY;
const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${key}`;

const ws = new WebSocket(wsUrl);

ws.on('open', () => {
  console.log('Connected');
  ws.send(JSON.stringify({
    setup: {
      model: 'models/gemini-2.0-flash',
      generationConfig: {
        responseModalities: ["TEXT"]
      }
    }
  }));
});

ws.on('message', (data) => {
  const msg = JSON.parse(data);
  if (msg.setupComplete) {
    console.log('Setup complete, sending text...');
    ws.send(JSON.stringify({
      clientContent: {
        turns: [{ role: 'user', parts: [{ text: 'hi' }] }],
        turnComplete: true
      }
    }));
  } else {
    console.log('Received:', JSON.stringify(msg, null, 2));
  }
});

ws.on('error', console.error);
ws.on('close', (code, reason) => console.log('Closed', code, reason.toString()));