// server.js
import express from 'express';
import bodyParser from 'body-parser';
import WebSocket from 'ws';

const app = express();
app.use(bodyParser.json());

// ----------------------
// 1️⃣ Connect to Blender MCP via WebSocket
// ----------------------
const MCP_WS_URL = 'ws://localhost:9876'; // Confirm this port from Blender MCP logs
let ws;

function connectMCP() {
  ws = new WebSocket(MCP_WS_URL);

  ws.on('open', () => {
    console.log('✅ Connected to Blender MCP via WebSocket');
  });

  ws.on('close', () => {
    console.warn('⚠ Blender MCP WebSocket connection closed. Reconnecting in 3s...');
    setTimeout(connectMCP, 3000);
  });

  ws.on('error', (err) => {
    console.error('❌ Blender MCP WebSocket error:', err.message);
  });

  ws.on('message', (data) => {
    console.log('📩 MCP Response:', data.toString());
  });
}

// Start connection
connectMCP();

// ----------------------
// 2️⃣ API Endpoint for Frontend
// ----------------------
app.post('/api/generate', (req, res) => {
  const { prompt } = req.body;
  console.log('✅ Received prompt:', prompt);

  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return res.status(500).json({
      status: 'error',
      message: 'MCP WebSocket is not connected. Try again later.'
    });
  }

  // Send prompt to Blender MCP
  ws.send(JSON.stringify({ command: 'run', prompt: prompt }));

  // Optional: wait for one-time response from MCP
  const responseHandler = (data) => {
    res.status(200).json({ status: 'success', data: data.toString() });
    ws.removeListener('message', responseHandler); // remove listener after first response
  };

  ws.on('message', responseHandler);
});

// ----------------------
// 3️⃣ Simple Health Check Endpoint
// ----------------------
app.get('/schema', (req, res) => {
  res.status(200).json({
    message: '✅ MCP Server is live!',
    endpoints: ['/run', '/schema']
  });
});

// ----------------------
// 4️⃣ Start Backend Server
// ----------------------
const PORT = 5000;
app.listen(PORT, () => {
  console.log(`🚀 Backend server running on http://localhost:${PORT}`);
});
