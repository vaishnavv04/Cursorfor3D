CursorFor3D
===========

CursorFor3D is an experimental desktop workflow that connects an Electron + React UI, a Node.js backend, Google Gemini, and the Blender MCP (Model Context Protocol) add-on. The goal is to let artists describe a scene in natural language, optionally include a reference image, and have the AI build the corresponding 3D model directly inside Blender.

## 🎯 Features

- **Continuous Chat Interface**: Have back-and-forth conversations to refine your 3D models iteratively
- **Dark UI**: Sleek, modern dark-themed interface for a premium user experience
- **Enhanced LLM Accuracy**: Improved prompts and context awareness for better model generation
- **Prompt Enhancement**: Automatically enhances user prompts for more detailed and accurate results
- **Conversation History**: Maintains context across multiple interactions
- **Scene Context Awareness**: Tracks current Blender scene state for intelligent modifications
- **Multi-Agent Repair Pipeline**: LangGraph orchestrated agents auto-repair Blender errors before returning results
- **Step-by-Step Progress Feed**: Backend emits structured timeline events for frontend progress visualizations

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

- Blender 4.5+ with the MCP add-on enabled on port 9876
- Node.js 20+
- A Google Gemini API key (Gemini 2.5 Flash or newer)
- (Optional) A Groq API key if you want automatic fallback when Gemini rate limits
- (Optional) Python virtual environment for the MCP add-on if you tweak it locally
- PostgreSQL database (or hosted equivalent like Supabase) for auth and chat persistence

1. Configure Environment
------------------------

1. In `backend/`, create a `.env` file (or copy from `.env.example` if present) and set:
	```
		# Required for auth and persistence
		JWT_SECRET=replace_with_strong_random_string
		DATABASE_URL=postgres://user:password@host:5432/dbname

		# LLM providers
		GEMINI_API_KEY=your_gemini_key
		GROQ_API_KEY=your_groq_key # optional fallback provider

		# Server ports
		PORT=5000                    # backend HTTP port
		BLENDER_TCP_HOST=127.0.0.1   # where Blender MCP listens
		BLENDER_TCP_PORT=9876        # Blender MCP TCP port

	```
2. Launch Blender, enable the MCP panel, and start the server so it listens on TCP port 9876.
3. Ensure your PostgreSQL instance is reachable from the backend. Supabase works out-of-the-box; SSL is auto-enabled when `DATABASE_URL` contains "supabase".

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
	The server listens on `http://localhost:5000` (configurable via `PORT`) and maintains a TCP connection to Blender MCP.

2. **Frontend + Electron shell**
	```powershell
	cd frontend
	npm run dev
	```
	This starts the React dev server on `http://localhost:3000` and launches the Electron window.

Generation Pipeline & Progress Telemetry
----------------------------------------

- The backend now routes generations through a LangGraph workflow (`backend/agents/langgraphPipeline.js`) that manages prompt creation, preflight checks, Blender execution, and automatic repair attempts.
- Each request builds a structured timeline via `backend/utils/progress.js`. The array is returned in every `/api/generate` response and saved on the assistant message for UI playback.
- Dry-run and A/B flows skip execution but still record model/validation steps for consistent progress display.
- Model selection gracefully handles Gemini aliases (e.g. `gemini-2.5-pro`) by mapping them to supported model IDs before calling the provider.

Usage
-----

1. Open the Electron window or navigate to the generator page in your browser.
2. Start a conversation by describing what you want to create.
3. Refine your model through continuous chat - ask for modifications, improvements, or changes.
4. Enable prompt enhancement for more detailed and accurate results.
5. Watch your 3D scene come to life in Blender as you iterate!

Troubleshooting
---------------

- **No response from Blender**: check the backend console for messages such as "Blender MCP not connected". Make sure the MCP panel is running on port 9876.
- **Gemini errors**: verify your `GEMINI_API_KEY` and the model name in `backend/server.js`.
- **Electron window blank**: wait for the React dev server to finish compiling or restart with `npm run dev`.
- **Backend exits on start**: ensure `JWT_SECRET` and `DATABASE_URL` are set. The backend will terminate if `JWT_SECRET` is missing, and will throw if no database connection string is provided.
- **Database connection errors**: confirm `DATABASE_URL` is valid and reachable. For Supabase, SSL is enabled automatically; for self-hosted Postgres, provide a standard connection string.

Roadmap Ideas
-------------

- Parse MCP responses to display build status in the UI
- Offer curated script templates for common primitives
- Add persistence for successful generations
- Conversation history persistence
- Multi-user support
- Advanced prompt templates
