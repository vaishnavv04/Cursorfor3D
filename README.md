<div align="center">

# 🎨 CursorFor3D

### **AI-Powered 3D Modeling Assistant for Blender**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Blender](https://img.shields.io/badge/Blender-4.5%2B-orange)](https://www.blender.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green)](https://nodejs.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-pgvector-blue)](https://github.com/pgvector/pgvector)

**Transform natural language into professional 3D models powered by LangGraph ReAct agents**

[Features](#-features) • [Quick Start](#-quick-start) • [Architecture](#-architecture) • [API Docs](#-api-documentation) • [Troubleshooting](#-troubleshooting)

</div>

---

## 📖 Overview

CursorFor3D is an intelligent 3D content creation system that combines **LangGraph ReAct agents**, **RAG-powered knowledge bases**, and **multiple 3D asset integrations** to convert natural language into Blender 3D models. Built with Node.js, React, and Electron, it provides a production-ready desktop application for AI-assisted 3D modeling.

### 🎯 Core Capabilities

- **🤖 LangGraph ReAct Agent**: Intelligent task decomposition with parallel execution and dynamic replanning
- **🧠 RAG Knowledge Base**: Vector embeddings of Blender 4.5 API documentation for context-aware code generation  
- **👁️ Vision Validation**: Gemini Vision API analyzes viewport screenshots for quality assurance
- **🌐 Multi-Integration**: Automatic routing between Hyper3D, Sketchfab, and PolyHaven
- **🔄 Circuit Breakers**: Resilient integration handling with automatic fallback
- **💾 Conversation Management**: Persistent chat history with PostgreSQL + pgvector
- **📊 Cost Tracking**: Built-in API usage monitoring and analytics
- **🔐 Production Security**: JWT authentication, rate limiting, and structured logging

---

## ✨ Features

### LangGraph ReAct Agent System

The core of CursorFor3D is a sophisticated **ReAct (Reason-Act-Observe) agent** built with LangGraph:

```
User Request → Task Decomposition → Parallel Execution → Validation → Response
                    ↓                      ↓                  ↓
              Subtask Planning      Tool Selection     Vision Check
                    ↓                      ↓                  ↓
             Dynamic Replanning    Circuit Breakers   Error Recovery
```

**Key Features:**
- **Atomic Task Decomposition**: Breaks complex requests into independently executable subtasks
- **Parallel Execution**: Runs independent subtasks simultaneously for faster completion
- **Dynamic Replanning**: Automatically generates alternative strategies when >50% of tasks fail
- **Conditional Logic**: Supports "if-then" fallback chains (e.g., "if integration fails, generate code")
- **Loop Protection**: Maximum 10 reasoning loops with automatic termination
- **State Management**: Maintains scene context, RAG context, and execution history

**Available Tools:**
1. `search_knowledge_base` - RAG search against Blender 4.5 API docs
2. `get_scene_info` - Retrieve current Blender scene state
3. `execute_blender_code` - Run sanitized Python code with auto-retry
4. `asset_search_and_import` - Smart routing to Hyper3D/Sketchfab/PolyHaven
5. `analyze_image` - Gemini Vision analysis of uploaded images
6. `validate_with_vision` - Screenshot-based quality validation
7. `create_animation` - Generate hop/walk/rotate/bounce animations
8. `finish_task` - Mark task complete with validation checks

### RAG-Powered Code Generation

**Vector Knowledge Base:**
- **380-dimensional embeddings** using `Xenova/all-MiniLM-L6-v2`
- **2044+ Blender API documentation chunks** indexed in pgvector
- **Cosine similarity search** (threshold > 0.2) for relevant context retrieval
- **Automatic code sanitization** removes deprecated Blender 4.5 parameters
- **Error-specific repair** with contextual fixes from knowledge base

**Blender 4.5 Compatibility:**
```python
# ✅ Current (4.5+)
bpy.ops.object.delete()  # No use_global
bpy.ops.mesh.primitive_cube_add(location=(0,0,0))  # No use_undo

# ❌ Deprecated (removed in 4.5)
bpy.ops.object.delete(use_global=False)
bpy.ops.mesh.primitive_cube_add(use_undo=True)
```

### Vision Validation System

**Gemini Vision API Integration:**
- **Viewport Screenshot Capture**: Automatic screenshot via `get_viewport_screenshot` command
- **Quality Scoring**: 0-10 scale with detailed breakdown
- **Visual Analysis**: Object detection, color verification, geometry quality
- **Issue Detection**: Identifies problems (missing objects, wrong colors, artifacts)
- **Actionable Suggestions**: Provides specific improvement recommendations

**Evaluation Criteria:**
- Object Presence (30%)
- Geometry Accuracy (25%)
- Material/Color (20%)
- Composition (15%)
- Technical Quality (10%)

### Multi-Integration System

**Smart Asset Routing:**

| Integration | Use Cases | Keywords | Circuit Breaker |
|-------------|-----------|----------|-----------------|
| **Hyper3D (Rodin)** | Photorealistic creatures, sculptures | realistic, dragon, monster | 3 failures = 30s timeout |
| **Sketchfab** | Branded models, specific objects | sketchfab, specific model, brand | 3 failures = 30s timeout |
| **PolyHaven** | Textures, HDRIs, generic furniture | texture, hdri, wooden chair | 3 failures = 30s timeout |
| **Procedural** | Everything else | _fallback_ | No limit |

**Circuit Breaker Protection:**
- **CLOSED**: Normal operation (all requests allowed)
- **HALF_OPEN**: Testing recovery (2 successes needed)
- **OPEN**: Service blocked (30s timeout)
- **Automatic Reset**: Self-healing when service recovers

### Network Resilience

**Timeout Protection:**
```python
# All Blender addon network requests now have timeouts
polyhaven_api_call(..., timeout=30)    # 11 API calls protected
download_file(..., timeout=60)          # 8 downloads protected
```

**Connection Management:**
- **Auto-Reconnect**: Exponential backoff (5s → 10s → 20s → 60s max)
- **Request Queue**: Sequential command processing prevents race conditions
- **Graceful Degradation**: Falls back to code generation when integrations fail

### API Cost Tracking

**Automatic Usage Monitoring:**
```sql
-- New table: api_usage
user_id | provider | model | usage | cost_usd | created_at
```

**Features:**
- **Auto-calculation**: Token counts → USD costs via configurable rates
- **Per-provider tracking**: Separate analytics for Gemini, Groq, etc.
- **Historical analysis**: Query usage by user, date range, or model
- **Cost optimization**: Identify expensive operations

---

## 🏗️ Architecture

### System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Electron + React Frontend                 │
│  (Chat UI, Attachment Handling, Progress Tracking)          │
└───────────────────────────┬─────────────────────────────────┘
                            │ HTTP/REST
┌───────────────────────────▼─────────────────────────────────┐
│                    Node.js Express Backend                   │
│  ┌──────────────────────────────────────────────────────┐  │
│  │          LangGraph ReAct Agent Engine                │  │
│  │  • Task Decomposition  • Parallel Execution          │  │
│  │  • Dynamic Replanning  • Tool Orchestration          │  │
│  └──────────────┬───────────────────────────────────────┘  │
│                 │                                            │
│  ┌──────────────▼───────────────────────────────────────┐  │
│  │      RAG System (pgvector + Embeddings)              │  │
│  │  • Blender API Docs  • Semantic Search               │  │
│  └──────────────┬───────────────────────────────────────┘  │
│                 │                                            │
│  ┌──────────────▼───────────────────────────────────────┐  │
│  │    Integration Layer (Circuit Breakers)              │  │
│  │  • Hyper3D • Sketchfab • PolyHaven • Vision API     │  │
│  └──────────────┬───────────────────────────────────────┘  │
└─────────────────┼────────────────────────────────────────┘
                  │ TCP Socket (Port 9876)
┌─────────────────▼────────────────────────────────────────┐
│              Blender 4.5+ with MCP Addon                 │
│  • Python Execution • Asset Import • Screenshot Capture  │
└──────────────────────────────────────────────────────────┘
```

### Tech Stack

**Backend:**
- **Runtime**: Node.js 20+ (ESM modules)
- **Framework**: Express.js 5.1
- **Agent**: LangGraph 1.0 + LangChain Core
- **Database**: PostgreSQL with pgvector extension
- **Embeddings**: `@xenova/transformers` (Xenova/all-MiniLM-L6-v2)
- **LLMs**: Google Gemini 2.5 Flash, Groq Llama 3.3 70B
- **Security**: JWT, bcrypt, express-rate-limit
- **Logging**: Winston 3.18

**Frontend:**
- **Framework**: React 18.3
- **Desktop**: Electron 31.7
- **Routing**: React Router DOM 6.30
- **Styling**: Tailwind CSS 3.4
- **Icons**: Lucide React, React Icons
- **State**: React Context + TanStack Query

**Infrastructure:**
- **TCP Communication**: Node.js `net` module (port 9876)
- **Python Environment**: Virtual environment (`venv-mcp`) for embedding model
- **Blender Addon**: Custom TCP server in `addon.py`

---

## 🚀 Quick Start

### Prerequisites

```bash
✅ Blender 4.5+ (with MCP addon installed)
✅ Node.js 20+ and npm
✅ PostgreSQL 14+ with pgvector extension
✅ Python 3.8+ (for embedding model)
✅ Google Gemini API key (primary LLM)
✅ Groq API key (prompt enhancement)
```

### Installation Steps

**1. Clone Repository**
```bash
git clone https://github.com/vaishnavv04/Cursorfor3D.git
cd CursorFor3D
```

**2. Backend Setup**
```bash
cd backend

# Create Python virtual environment
python -m venv venv-mcp
# Windows:
.\venv-mcp\Scripts\activate
# macOS/Linux:
source venv-mcp/bin/activate

# Install Python dependencies
pip install requests pillow numpy

# Install Node.js dependencies
npm install
```

**3. Environment Configuration**

Create `backend/.env`:
```env
# Required
JWT_SECRET=your_secure_random_string_min_32_chars
DATABASE_URL=postgresql://user:password@localhost:5432/cursor3d
GEMINI_API_KEY=your_google_gemini_api_key
GROQ_API_KEY=your_groq_api_key

# Blender Connection
BLENDER_TCP_HOST=127.0.0.1
BLENDER_TCP_PORT=9876

# Optional Integrations
SKETCHFAB_API_KEY=your_sketchfab_api_key

# Performance Tuning
CODE_CACHE_MAX=100
CODE_CACHE_TTL_MS=300000
RATE_LIMIT_MAX=30
RATE_LIMIT_WINDOW_MS=60000
```

**4. Database Setup**
```sql
-- Create database
CREATE DATABASE cursor3d;
\c cursor3d;

-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Schema auto-initializes on first run
```

**5. Initialize Knowledge Base**
```bash
cd backend
node scripts/embed_docs.js
# Embeds 2044+ Blender API documentation chunks
```

**6. Frontend Setup**
```bash
cd frontend
npm install
```

**7. Blender Setup**
- Install Blender 4.5+
- Load `backend/addon.py` as addon
- Enable MCP server (port 9876)
- Verify connection in console

### Running the Application

**Terminal 1 - Backend:**
```bash
cd backend
# Activate Python venv first
.\venv-mcp\Scripts\activate  # Windows
source venv-mcp/bin/activate  # macOS/Linux
npm start
```

**Terminal 2 - Frontend:**
```bash
cd frontend
npm run dev  # Development mode with hot reload
# OR
npm run build && npm start  # Production build
```

**Verification:**
- Backend: http://localhost:5000 (API ready)
- Frontend: Electron window opens automatically
- Blender: Check console for "Connected to Blender TCP server"

---

## 📚 API Documentation

### REST Endpoints

#### Authentication
```http
POST /api/auth/signup
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "securepassword",
  "displayName": "John Doe"
}

Response: { "token": "jwt_token", "user": {...} }
```

```http
POST /api/auth/login
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "securepassword"
}

Response: { "token": "jwt_token", "user": {...} }
```

#### Generation (LangGraph Agent)
```http
POST /api/generate
Authorization: Bearer {token}
Content-Type: application/json

{
  "prompt": "Create a red metallic cube at origin",
  "conversationId": "uuid-or-null",
  "model": "gemini",
  "captureScreenshot": false,
  "debug": false,
  "attachments": [
    {
      "name": "reference.jpg",
      "type": "image/jpeg",
      "dataUrl": "data:image/jpeg;base64,..."
    }
  ]
}

Response: {
  "success": true,
  "response": "✅ Here you go! I've completed your request...",
  "blenderResult": { "status": "success", "result": "..." },
  "conversationId": "uuid",
  "messages": [...],
  "provider": "gemini-2.5-flash",
  "progress": [...],
  "langGraph": true,
  "loopCount": 5,
  "finished": true
}
```

#### Prompt Enhancement
```http
POST /api/enhance-prompt
Authorization: Bearer {token}
Content-Type: application/json

{
  "prompt": "add a chair",
  "conversationHistory": [...]
}

Response: { "enhancedPrompt": "Create a detailed wooden chair..." }
```

#### Conversation Management
```http
GET /api/conversations
Authorization: Bearer {token}

Response: { "conversations": [...] }
```

```http
GET /api/conversation/:id
Authorization: Bearer {token}

Response: { "conversation": {...}, "messages": [...] }
```

```http
DELETE /api/conversation/:id
Authorization: Bearer {token}

Response: { "success": true }
```

#### Health & Monitoring
```http
GET /api/health

Response: {
  "status": "healthy",
  "timestamp": "2025-11-18T...",
  "uptime": 3600,
  "services": {
    "blender": { "connected": true, "host": "127.0.0.1", "port": 9876 },
    "database": { "status": "connected" },
    "apiKeys": { "gemini": "configured", "groq": "configured" },
    "integrations": {
      "hyper3d": "enabled",
      "polyhaven": "enabled",
      "sketchfab": "disabled"
    },
    "circuitBreakers": {
      "hyper3d": { "state": "CLOSED", "failureCount": 0 },
      "sketchfab": { "state": "OPEN", "nextAttempt": 1731931200000 },
      "polyhaven": { "state": "CLOSED", "failureCount": 0 }
    },
    "rag": {
      "status": "available",
      "tables": { "blender_knowledge_new": true, "blender_knowledge": true },
      "embeddingModel": "Xenova/all-MiniLM-L6-v2"
    }
  }
}
```

---

## 🛠️ Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `JWT_SECRET` | ✅ | - | Secret for JWT signing (32+ chars) |
| `DATABASE_URL` | ✅ | - | PostgreSQL connection string |
| `GEMINI_API_KEY` | ✅ | - | Google Gemini API key |
| `GEMINI_API_KEY_1`, `_2`, `_3` | ❌ | - | Multiple keys for rotation |
| `GROQ_API_KEY` | ✅ | - | Groq API for prompt enhancement |
| `SKETCHFAB_API_KEY` | ❌ | - | Sketchfab integration (optional) |
| `BLENDER_TCP_HOST` | ❌ | 127.0.0.1 | Blender addon host |
| `BLENDER_TCP_PORT` | ❌ | 9876 | Blender addon port |
| `PORT` | ❌ | 5000 | Backend server port |
| `CODE_CACHE_MAX` | ❌ | 100 | Max cached code entries |
| `CODE_CACHE_TTL_MS` | ❌ | 300000 | Cache TTL (5 min) |
| `RATE_LIMIT_MAX` | ❌ | 30 | Max requests per window |
| `RATE_LIMIT_WINDOW_MS` | ❌ | 60000 | Rate limit window (1 min) |

---

## 🔧 Troubleshooting

### Common Issues

#### ❌ "Blender is not connected"
**Symptoms:** Agent cannot execute code or import assets

**Solutions:**
1. Ensure Blender is running with `addon.py` loaded
2. Check MCP server is active (green indicator in Blender sidebar)
3. Verify `BLENDER_TCP_PORT=9876` in `.env`
4. Check backend console for reconnection attempts
5. Restart Blender and reload addon if connection fails repeatedly

#### ❌ "Circuit breaker is OPEN"
**Symptoms:** Integration (Hyper3D/Sketchfab/PolyHaven) unavailable

**Solutions:**
1. Wait 30 seconds for automatic recovery attempt
2. Check integration status: `GET /api/health`
3. Verify API keys in Blender addon settings
4. Check rate limits on integration provider dashboards
5. Manually reset via Blender MCP panel

#### ❌ "Knowledge base not initialized"
**Symptoms:** RAG searches return no results

**Solutions:**
1. Run: `node scripts/embed_docs.js`
2. Check `blender_knowledge_new` table exists in database
3. Verify pgvector extension: `CREATE EXTENSION IF NOT EXISTS vector;`
4. Ensure Python venv is activated when running embed script
5. Check `scripts/knowledge/` directory has Blender docs

#### ❌ "Task completed with issues"
**Symptoms:** Agent finishes but some operations failed

**Solutions:**
1. Enable debug mode: `{ "debug": true }` in API request
2. Check `progress` array for specific failure details
3. Verify Blender viewport is in correct mode (OBJECT/EDIT)
4. Review `subtaskResults` in response for error messages
5. Try breaking complex requests into smaller steps

#### ❌ "Vision validation failed"
**Symptoms:** Screenshot analysis not working

**Solutions:**
1. Ensure at least one 3D viewport is open in Blender
2. Check Gemini API has vision capabilities enabled
3. Verify screenshot capture works: Test with `get_viewport_screenshot` command
4. Switch viewport to rendered/solid shading mode
5. Check temp directory has write permissions

### Debug Mode

Enable verbose logging:
```javascript
// In API request
{
  "prompt": "your prompt",
  "debug": true  // Returns full agent state and reasoning
}
```

**Backend Logs:**
```bash
# Set log level in backend
export LOG_LEVEL=debug
npm start
```

**Frontend DevTools:**
```
Ctrl+Shift+I (Windows/Linux)
Cmd+Option+I (macOS)
```

### Performance Optimization

**Slow Generation:**
- Use `CODE_CACHE_MAX=200` for better caching
- Enable parallel execution (automatic in LangGraph)
- Pre-warm RAG context with common queries
- Use Gemini 2.5 Flash (faster than Groq for code)

**High API Costs:**
- Monitor via cost tracking in database
- Use prompt enhancement selectively
- Cache frequently used code patterns
- Reduce `maxLoops` to 5 for simple tasks

---

## 🤝 Contributing

We welcome contributions! Areas for improvement:

### High Priority
- [ ] Add OpenAI GPT-4 as alternative LLM
- [ ] Implement batch generation for multiple objects
- [ ] Add Blender scene diff viewer
- [ ] Create automated test suite for agent workflows
- [ ] Improve vision validation with multi-angle screenshots

### Feature Requests
- [ ] Support for animation timeline editing
- [ ] Real-time collaboration via WebSockets
- [ ] Export to GLTF/FBX/USD formats
- [ ] Material library with PBR presets
- [ ] Voice input for hands-free modeling

### Code Quality
- [ ] Add TypeScript types for backend
- [ ] Increase test coverage to 80%+
- [ ] Performance profiling for agent loops
- [ ] API documentation with Swagger/OpenAPI

**To Contribute:**
```bash
git checkout -b feature/your-feature-name
# Make changes
git commit -m "feat: add amazing feature"
git push origin feature/your-feature-name
# Open Pull Request
```

---

## 📄 License

MIT License - See [LICENSE](LICENSE) file

---

## 🙏 Acknowledgments

- **Blender Foundation** - Open-source 3D creation suite
- **Google** - Gemini 2.5 Flash and Vision API
- **Groq** - Fast inference for Llama models
- **LangChain** - LangGraph framework for agent workflows
- **pgvector** - Vector similarity search in PostgreSQL
- **Hyper3D/Rodin** - Photorealistic 3D generation
- **PolyHaven** - High-quality CC0 3D assets
- **Sketchfab** - Extensive 3D model library

---

## 📮 Support & Community

- **Issues**: [GitHub Issues](https://github.com/vaishnavv04/Cursorfor3D/issues)
- **Discussions**: [GitHub Discussions](https://github.com/vaishnavv04/Cursorfor3D/discussions)
- **Repository**: [github.com/vaishnavv04/Cursorfor3D](https://github.com/vaishnavv04/Cursorfor3D)

---

<div align="center">

**Built with ❤️ by [vaishnavv04](https://github.com/vaishnavv04)**

*Star ⭐ this repository if you find it helpful!*

**Last Updated:** January 2025

</div>
