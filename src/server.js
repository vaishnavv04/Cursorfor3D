import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import WebSocket from "ws";
import { GoogleGenerativeAI } from "@google/generative-ai";

dotenv.config();

const app = express();
app.use(cors());
app.use(bodyParser.json());

const PORT = 5000;
const BLENDER_MCP_URL = "ws://localhost:9876";

// Gemini setup
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

// Connect to Blender MCP
let blenderSocket;
try {
  blenderSocket = new WebSocket(BLENDER_MCP_URL);
  blenderSocket.on("open", () => console.log("✅ Connected to Blender MCP"));
  blenderSocket.on("error", (err) =>
    console.error("❌ Blender MCP error:", err.message)
  );
} catch (err) {
  console.error("⚠️ Failed to connect to Blender MCP:", err.message);
}

// API route
app.post("/api/generate", async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: "Prompt required" });

  try {
    // Get AI response from Gemini
    const result = await model.generateContent(prompt);
    const geminiResponse = result.response.text();

    // Optionally forward to Blender MCP
    if (blenderSocket && blenderSocket.readyState === WebSocket.OPEN) {
      blenderSocket.send(JSON.stringify({ command: prompt }));
    }

    res.json({ output: geminiResponse });
  } catch (error) {
    console.error("Gemini Error:", error.message);
    res.status(500).json({ error: "Gemini API call failed" });
  }
});

// Start backend server
app.listen(PORT, () =>
  console.log(`🚀 Server running on http://localhost:${PORT}`)
);
