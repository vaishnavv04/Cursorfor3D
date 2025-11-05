CursorFor3D
===========

CursorFor3D is an experimental desktop workflow that connects an Electron + React UI, a Node.js backend, Google Gemini, and the Blender MCP (Model Context Protocol) add-on. The goal is to let artists describe a scene in natural language, optionally include a reference image, and have the AI build the corresponding 3D model directly inside Blender.

Project Structure
-----------------

```
CursorFor3D/
├── backend/         # Node.js API server + Gemini bridge
├── frontend/        # React app rendered inside Electron
└── README.md
```

Prerequisites
-------------

- Blender 4.2+ with the MCP add-on enabled on port 9876
- Node.js 20+
- A Google Gemini API key (Gemini 2.5 Flash or newer)
- (Optional) A Groq API key if you want automatic fallback when Gemini rate limits
- (Optional) Python virtual environment for the MCP add-on if you tweak it locally

1. Configure Environment
------------------------

1. In `backend/`, copy `.env.example` to `.env` (create the example file if needed) and set:
	```
		GEMINI_API_KEY=your_gemini_key
		GROQ_API_KEY=your_groq_key # optional fallback provider
	```
2. Launch Blender, enable the MCP panel, and start the server so it listens on TCP port 9876.

2. Install Dependencies
-----------------------

From the repo root:

```powershell
cd backend
npm install

cd ..\frontend
npm install
```

3. Run the Stack
----------------

1. **Backend**
	```powershell
	cd backend
	npm start
	```
	The server listens on `http://localhost:5000` and maintains a TCP connection to Blender MCP.

2. **Frontend + Electron shell**
	```powershell
	cd frontend
	npm run dev
	```
	This starts the React dev server on `http://localhost:3000` and launches the Electron window.

Usage
-----

1. Open the Electron window.
2. Type a scene description in the text prompt and optionally attach an image for extra context.
3. Submit the request. The UI shows the raw Python code returned from Gemini and relays it to Blender MCP.
4. Inspect Blender to watch the script execute.

Troubleshooting
---------------

- **No response from Blender**: check the backend console for messages such as “Blender MCP not connected”. Make sure the MCP panel is running on port 9876.
- **Gemini errors**: verify your `GEMINI_API_KEY` and the model name in `backend/server.js`.
- **Electron window blank**: wait for the React dev server to finish compiling or restart with `npm run dev`.

Roadmap Ideas
-------------

- Parse MCP responses to display build status in the UI
- Offer curated script templates for common primitives
- Add persistence for successful generations
