# 🎨 CursorFor3D - AI-Powered 3D Modeling Assistant

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT) [![Version](https://img.shields.io/badge/version-1.0.0-blue)](https://github.com/vaishnavv04/Cursorfor3D)

CursorFor3D revolutionizes 3D content creation by combining the power of AI with professional 3D modeling. This desktop application built with Electron allows artists and designers to create complex 3D models and scenes using natural language descriptions, while intelligently leveraging multiple generation methods for optimal results.

## ✨ Key Features

### 🤖 AI-Powered 3D Generation
- **Natural Language to 3D**: Convert text descriptions into detailed 3D models using Google Gemini 2.5 Flash
- **Multi-Source Generation**: Automatically selects the best approach from:
  - **Hyper3D/Rodin**: High-quality, photorealistic 3D models from text prompts
  - **Sketchfab Integration**: Access to thousands of pre-made 3D assets
  - **PolyHaven Assets**: High-quality HDRIs, textures, and 3D models
  - **Procedural Generation**: Custom Blender Python code generation for complex scenes

### 🎯 Smart Features
- **Intelligent Prompt Enhancement**: Groq-powered llama-3.1-8b-instant model enhances prompts for better results
- **Context-Aware Modeling**: Maintains scene context and spatial relationships across conversations
- **Automatic Error Recovery**: Multi-agent system for automatic error detection and code repair
- **Real-Time Progress Tracking**: Structured timeline events with detailed generation steps
- **Visual Refinement**: Optional viewport screenshot analysis for iterative improvements

### 💻 Technical Architecture
- **Blender MCP Integration**: Direct TCP communication with Blender's Model Context Protocol (port 9876)
- **Dual-LLM System**: 
  - **Google Gemini 2.5 Flash**: Primary model for Blender code generation, scene understanding, and error recovery
  - **Groq llama-3.1-8b-instant**: Fast prompt enhancement for improved generation quality
- **Modern Frontend**: Electron + React with Tailwind CSS for responsive UI
- **Backend API**: Node.js/Express server with PostgreSQL for data persistence
- **Smart Caching**: LRU cache reduces redundant API calls for similar prompts

## 🚀 Quick Start

### Prerequisites

- **Blender 4.5+** with MCP add-on enabled on port 9876
- **Node.js 20+** and npm
- **Google Gemini API key** (required for Blender code generation)
- **Groq API key** (required for prompt enhancement)
- **PostgreSQL** database (or Supabase)
- **Python 3.x** with virtual environment support
- (Optional) **Sketchfab API key** for additional 3D model access

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/vaishnavv04/Cursorfor3D.git
   cd CursorFor3D
   ```

2. **Set up Python virtual environment (backend)**
   ```bash
   cd backend
   python -m venv venv-mcp
   # On Windows:
   .\venv-mcp\Scripts\activate
   # On macOS/Linux:
   source venv-mcp/bin/activate
   
   # Install Python dependencies
   pip install -r requirements.txt
   ```

3. **Configure environment variables**
   
   Create a `.env` file in the `backend` directory:
   ```env
   # Required
   JWT_SECRET=your_secure_jwt_secret_here
   DATABASE_URL=postgresql://user:password@localhost:5432/cursor3d
   GEMINI_API_KEY=your_gemini_api_key_here
   GROQ_API_KEY=your_groq_api_key_here
   
   # Optional Integrations
   SKETCHFAB_API_KEY=your_sketchfab_key_here
   
   # Server Configuration
   PORT=5000
   BLENDER_TCP_HOST=127.0.0.1
   BLENDER_TCP_PORT=9876
   
   # Model Configuration
   GEMINI_MODEL=gemini-2.5-flash
   LLM_REPAIR_ATTEMPTS=2
   
   # Caching Configuration
   CODE_CACHE_MAX=100
   CODE_CACHE_TTL_MS=300000
   
   # Rate Limiting
   RATE_LIMIT_WINDOW_MS=60000
   RATE_LIMIT_MAX=30
   ```

4. **Install backend dependencies**
   ```bash
   npm install
   ```

5. **Install frontend dependencies**
   ```bash
   cd ../frontend
   npm install
   ```

6. **Set up PostgreSQL database**
   
   Create a database and run the schema initialization:
   ```sql
   CREATE DATABASE cursor3d;
   ```
   
   The schema will be automatically initialized on first run.

7. **Set up Blender**
   - Install Blender 4.5 or higher
   - Install and enable the MCP add-on
   - Configure it to listen on `127.0.0.1:9876`
   - Start the MCP server in Blender

### Running the Application

1. **Start the backend server**
   ```bash
   cd backend
   npm start
   ```
   Server will start on `http://localhost:5000`

2. **Build and start the frontend**
   ```bash
   cd ../frontend
   npm run build
   npm start
   ```
   The Electron app will launch automatically.

3. **Verify Blender connection**
   - Ensure Blender is running with MCP add-on active
   - Check backend console for "✅ Connected to Blender addon socket server" message

## 🎨 Usage Guide

### Getting Started

1. **Create an account**
   - Launch the application
   - Sign up with email and password (minimum 8 characters)
   - Log in to access the generation interface

2. **Start a conversation**
   - Click "New Scene" to create a new conversation
   - Type your 3D model description in natural language
   - Enable "Enhance Prompt" for more detailed results (optional)

3. **Generate 3D content**
   - Example prompts:
     - "Create a realistic dragon with detailed scales"
     - "Add a wooden chair next to the table"
     - "Create a procedural terrain with mountains"
     - "Apply a metallic material to the sphere"
     - "Add an HDRI sky texture"

4. **Refine and iterate**
   - Continue the conversation to refine your model
   - Ask for specific modifications
   - The system maintains scene context throughout

### Advanced Features

#### Prompt Enhancement
Enable "Enhance Prompt" to automatically improve your descriptions with technical details using Groq's llama-3.1-8b-instant model for better generation quality.

#### Visual Refinement
The system can capture viewport screenshots and suggest improvements based on visual analysis using Gemini's vision capabilities.

#### Multiple Generation Sources
The system automatically detects the best generation method based on keywords:
- **Hyper3D/Rodin**: Photorealistic models (keywords: realistic, photorealistic, creature, dragon, monster, sculpture, high detail)
- **Sketchfab**: Specific branded models (keywords: specific model, brand name, realistic car)
- **PolyHaven**: Textures, HDRIs, and generic assets (keywords: texture, hdri, material, wooden chair, table)
- **Procedural**: Custom Blender Python code generation for everything else

#### Error Recovery
If code execution fails, the system automatically:
1. Analyzes the error message
2. Generates targeted fixes using Gemini
3. Retries execution (up to 2 additional attempts)
4. Provides helpful hints for common issues

## 📚 API Documentation

### Project Structure
```
CursorFor3D/
├── backend/                    # Node.js Express API server
│   ├── addon.py               # Python script for Blender MCP addon
│   ├── server.js              # Main server file with all endpoints
│   ├── db.js                  # PostgreSQL database configuration
│   ├── package.json           # Backend dependencies
│   ├── integrations/          # External service integrations
│   │   ├── hyper3d.js        # Hyper3D/Rodin API integration
│   │   ├── polyhaven.js      # PolyHaven asset integration
│   │   ├── sketchfab.js      # Sketchfab API integration
│   │   └── check_integration.js  # Integration status checks
│   ├── utils/                 # Utility modules
│   │   ├── progress.js       # Progress tracking system
│   │   └── hyper3dPrompt.js  # Hyper3D prompt helpers
│   └── venv-mcp/             # Python virtual environment
├── frontend/                  # React + Electron desktop app
│   ├── main.js               # Electron main process
│   ├── package.json          # Frontend dependencies
│   ├── build/                # Production build output
│   ├── public/               # Static assets
│   └── src/                  # React source code
│       ├── App.js            # Main application component
│       ├── components/       # Reusable components
│       │   ├── ChatInterface.jsx    # Chat UI
│       │   ├── Promptcard.jsx      # Prompt input card
│       │   ├── navbar.js           # Navigation bar
│       │   └── authmodel.js        # Authentication modal
│       ├── context/          # React context providers
│       │   └── AuthContext.jsx     # Authentication context
│       └── pages/            # Page components
│           ├── homepage.js         # Landing page
│           ├── authpage.js         # Login/signup page
│           └── generatorpage.js   # Main generation interface
└── README.md                 # This file
```

### REST API Endpoints

#### Authentication
- `POST /api/auth/signup` - Create new user account
  - Body: `{ email, password, displayName? }`
  - Returns: `{ token, user }`

- `POST /api/auth/login` - Authenticate user
  - Body: `{ email, password }`
  - Returns: `{ token, user }`

- `GET /api/auth/me` - Get current user
  - Headers: `Authorization: Bearer <token>`
  - Returns: `{ user }`

#### Conversations
- `GET /api/conversations` - List all user conversations
  - Returns: `{ conversations: [...] }`

- `POST /api/conversation/new` - Create new conversation
  - Body: `{ title? }`
  - Returns: `{ conversation }`

- `GET /api/conversation/:conversationId` - Get conversation details
  - Returns: `{ conversation, messages }`

- `DELETE /api/conversation/:conversationId` - Delete conversation
  - Returns: `{ success: true }`

#### Generation
- `POST /api/generate` - Generate 3D content (full response)
  - Body: `{ prompt, conversationId?, enhancePrompt?, captureScreenshot?, dryRun?, debug?, visualRefine?, agentType? }`
  - Returns: `{ response, blenderResult, provider, conversationId, messages, attempts, screenshot?, progress }`

- `GET /api/generate/stream` - Generate with real-time progress (Server-Sent Events)
  - Query: `?prompt=...&conversationId=...&captureScreenshot=...`
  - Streams: `event: status/error/complete`

- `POST /api/enhance-prompt` - Enhance prompt before generation
  - Body: `{ prompt, conversationId? }`
  - Returns: `{ enhancedPrompt }`

- `POST /api/scene-info` - Get current Blender scene information
  - Body: `{ conversationId? }`
  - Returns: Scene context object

#### Analytics & Feedback
- `POST /api/feedback` - Submit feedback on generation
  - Body: `{ conversationId, messageId, rating: 'up'|'down' }`
  - Returns: `{ ok: true }`

- `GET /api/analytics/summary` - Get generation statistics
  - Returns: `{ totalGenerations, success, errors, avgAttempts, avgDurationMs }`

- `GET /api/suggest` - Get prompt suggestions
  - Query: `?prefix=...`
  - Returns: `{ suggestions: [...] }`

## 🛠️ Technical Details

### Blender Code Generation
The system generates Blender 4.5-compatible Python code with strict validation:
- Automatic import of `bpy` module
- Removal of deprecated parameters (`use_undo`, `use_global`, `constraint_axis`)
- Fix for Blender 4.5 API changes (Voronoi/Musgrave node updates)
- Safe deletion patterns and edit mode handling
- Error-specific hints for common issues

### Smart Caching
- **LRU Cache**: Stores generated code with SHA-256 hash keys
- **Configurable TTL**: Default 5 minutes (300,000ms)
- **Cache Size**: Max 100 entries (configurable)
- Reduces redundant API calls for similar prompts

### Rate Limiting
- Per-user rate limiting (in-memory)
- Default: 30 requests per 60 seconds
- Returns 429 status with `Retry-After` header when exceeded

### Progress Tracking
Structured timeline with stages:
- `init` - Starting workflow
- `conversation_lookup/create` - Managing conversation
- `scene_context` - Fetching Blender scene
- `integration_check` - Checking available integrations
- `orchestrate_*` - Asset integration steps
- `model_generate` - AI code generation
- `attempt` - Execution attempts
- `screenshot` - Viewport capture
- `visual_refine` - Visual refinement

### Database Schema
**Tables:**
- `users` - User accounts with bcrypt password hashing
- `conversations` - Chat sessions with scene context
- `messages` - Conversation messages with metadata

All timestamps use PostgreSQL `TIMESTAMP WITH TIME ZONE` for consistency.

## 🔧 Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `JWT_SECRET` | Yes | - | Secret key for JWT token signing |
| `DATABASE_URL` | Yes | - | PostgreSQL connection string |
| `GEMINI_API_KEY` | Yes | - | Google Gemini API key |
| `GROQ_API_KEY` | Yes | - | Groq API key for prompt enhancement |
| `SKETCHFAB_API_KEY` | No | - | Sketchfab API key (optional) |
| `PORT` | No | 5000 | Backend server port |
| `BLENDER_TCP_HOST` | No | 127.0.0.1 | Blender MCP host |
| `BLENDER_TCP_PORT` | No | 9876 | Blender MCP port |
| `GEMINI_MODEL` | No | gemini-2.5-flash | Gemini model to use |
| `LLM_REPAIR_ATTEMPTS` | No | 2 | Max code repair attempts |
| `CODE_CACHE_MAX` | No | 100 | Max cache entries |
| `CODE_CACHE_TTL_MS` | No | 300000 | Cache TTL in milliseconds |
| `RATE_LIMIT_WINDOW_MS` | No | 60000 | Rate limit window |
| `RATE_LIMIT_MAX` | No | 30 | Max requests per window |

## 🤝 Contributing

We welcome contributions! Here's how you can help:

### Getting Started
1. Fork the repository
2. Create a feature branch (`git checkout -b feature/AmazingFeature`)
3. Make your changes
4. Test thoroughly
5. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
6. Push to the branch (`git push origin feature/AmazingFeature`)
7. Open a Pull Request

### Development Guidelines
- Follow existing code style
- Add comments for complex logic
- Update README if adding new features
- Test with Blender 4.5+
- Ensure backward compatibility where possible

### Areas for Contribution
- Additional integration sources (more 3D asset libraries)
- UI/UX improvements
- Performance optimizations
- Bug fixes and error handling
- Documentation improvements
- Test coverage

## � Troubleshooting

### Common Issues

#### Backend Connection Issues
- **"Blender MCP not connected"**
  - Ensure Blender is running with MCP add-on enabled
  - Check that MCP is listening on port 9876
  - Verify `BLENDER_TCP_HOST` and `BLENDER_TCP_PORT` in `.env`
  - Check backend console for connection status

#### API Key Errors
- **Gemini API errors**
  - Verify `GEMINI_API_KEY` is valid and active
  - Check API quota limits on Google Cloud Console
  - Ensure billing is enabled for the API key

- **Groq API errors**
  - Verify `GROQ_API_KEY` is valid
  - Check rate limits on Groq dashboard
  - Prompt enhancement will fall back to original prompt if Groq fails

#### Database Issues
- **"Database connection failed"**
  - Verify PostgreSQL is running
  - Check `DATABASE_URL` format: `postgresql://user:password@host:port/database`
  - Ensure database exists: `CREATE DATABASE cursor3d;`
  - Check PostgreSQL logs for connection errors

#### Authentication Issues
- **"JWT_SECRET environment variable is required"**
  - Add `JWT_SECRET` to `.env` file
  - Use a secure random string (at least 32 characters)
  - Restart backend server after adding

#### Generation Failures
- **"Timeout: No response for [command]"**
  - Long-running operations (Hyper3D, downloads) have 60s timeout
  - Check Blender console for errors
  - Verify internet connection for API calls

- **Blender execution errors**
  - Check that objects are selected when required
  - Ensure correct mode (OBJECT vs EDIT)
  - System automatically retries with fixes up to 2 times

#### Frontend Issues
- **Electron window blank**
  - Wait for React dev server to finish compiling
  - Check browser console (Ctrl+Shift+I) for errors
  - Try rebuilding: `npm run build`

- **Connection refused**
  - Ensure backend is running on port 5000
  - Check for port conflicts
  - Verify frontend is configured to connect to correct backend URL

### Debug Mode
Enable debug mode for detailed information:
```javascript
// In API request body
{
  "prompt": "your prompt",
  "debug": true  // Includes full prompts and system messages
}
```

### Logs
- **Backend logs**: Check terminal running `npm start` in backend directory
- **Blender logs**: Check Blender's system console (Window > Toggle System Console on Windows)
- **Frontend logs**: Open DevTools (Ctrl+Shift+I) in Electron app

## 📝 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- **Blender Foundation** - For the amazing open-source 3D creation suite
- **Google** - For Gemini 2.5 Flash AI model powering code generation
- **Groq** - For fast prompt enhancement with llama-3.1-8b-instant
- **OpenAI** - For inspiration in AI-assisted content creation
- **Hyper3D/Rodin** - For high-quality 3D model generation API
- **Sketchfab** - For extensive 3D model library
- **PolyHaven** - For high-quality open-source 3D assets
- The open-source community for countless libraries and tools

## 📮 Contact & Support

- **GitHub Issues**: [Report bugs or request features](https://github.com/vaishnavv04/Cursorfor3D/issues)
- **Repository**: [github.com/vaishnavv04/Cursorfor3D](https://github.com/vaishnavv04/Cursorfor3D)

## 🗺️ Roadmap

### Planned Features
- [ ] Support for additional 3D asset sources
- [ ] Batch generation for multiple objects
- [ ] Export to various 3D formats (GLB, FBX, OBJ)
- [ ] Collaborative scene editing
- [ ] Preset templates for common scenes
- [ ] Animation generation capabilities
- [ ] Material library integration
- [ ] Cloud rendering support
- [ ] Mobile companion app
- [ ] Plugin system for extensibility

### In Progress
- [x] Hyper3D integration for realistic models
- [x] PolyHaven asset integration
- [x] Sketchfab model search and import
- [x] Error recovery system
- [x] Progress tracking
- [x] Prompt enhancement

---

**Built with ❤️ by [vaishnavv04](https://github.com/vaishnavv04)**

*Star ⭐ this repository if you find it helpful!*
