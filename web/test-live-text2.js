require('dotenv').config({ path: '.env.local' });
require('dotenv').config();
const WebSocket = require('ws');
const key = process.env.GOOGLE_API_KEY || process.env.NEXT_PUBLIC_GEMINI_API_KEY;
if (!key) throw new Error("No API key");
const ws = new WebSocket(`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${key}`);
ws.on('open', () => {
  ws.send(JSON.stringify({
    setup: {
      model: 'models/gemini-2.0-flash-exp', // Try 2.0-flash-exp or 2.0-flash
      generationConfig: { responseModalities: ["TEXT"] }
    }
  }));
});
ws.on('message', (data) => {
  const parsed = JSON.parse(data.toString());
  console.log(JSON.stringify(parsed, null, 2));
  if (parsed.serverContent && parsed.serverContent.modelTurn) {
      ws.close();
  } else if (parsed.setupComplete) {
      console.log('Setup successful!');
      ws.close();
  }
});
ws.on('error', console.error);
ws.on('close', (c, r) => console.log('Closed', c, r.toString()));