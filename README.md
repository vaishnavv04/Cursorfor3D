# 🔌 CursorFor3D - AI-Powered 3D Modeling Assistant

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT) [![Version](https://img.shields.io/badge/version-1.2.0-blue)](https://github.com/yourusername/CursorFor3D/releases)

CursorFor3D revolutionizes 3D content creation by combining the power of AI with professional 3D modeling. This desktop application allows artists and designers to create complex 3D models and scenes using natural language descriptions, while intelligently leveraging multiple generation methods for optimal results.

## 💯 Key Features

### 🔍 AI-Powered 3D Generation
- **Natural Language to 3D**: Convert text descriptions into detailed 3D models
- **Multi-Source Generation**: Automatically selects the best approach from:
  - **Hyper3D/Rodin**: For high-quality, detailed models
  - **Sketchfab Integration**: Access to thousands of pre-made 3D assets
  - **PolyHaven Assets**: High-quality HDRIs, textures, and models
  - **Procedural Generation**: Custom Blender Python code when needed

### ⚙️ Advanced Features
- **Intelligent Asset Pipeline**: Automatically sources and integrates 3D assets
- **Hybrid Workflow**: Seamlessly combines AI generation with manual refinement
- **Context-Aware Modeling**: Maintains scene context and spatial relationships
- **Error Recovery**: Multi-agent system for automatic error detection and repair
- **Progress Visualization**: Real-time feedback on generation progress

### 💻 Technical Highlights
- **Blender MCP Integration**: Direct communication with Blender's Model Context Protocol
- **Dual-LLM Architecture**: 
  - **Gemini 2.5 Flash**: Main model for Blender code generation and scene understanding
  - **Groq llama-3.1-8b-instant**: Dedicated prompt enhancement for better generation quality
- **Responsive UI**: Built with Electron + React and Tailwind CSS
- **Modular Architecture**: Easy to extend with new generation methods and integrations
- **Step-by-Step Progress Feed**: Backend emits structured timeline events for frontend progress visualizations

## 🚀 Quick Start

### Prerequisites

- **Blender 4.5+** with the MCP add-on enabled on port 9876
- **Node.js 20+**
- **Google Gemini API key** (required for main code generation)
- **Groq API key** (required for prompt enhancement using llama-3.1-8b-instant)
- **PostgreSQL** (or Supabase) for data persistence
- (Optional) **Sketchfab API key** for 3D model access

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/yourusername/CursorFor3D.git
   cd CursorFor3D
   ```

2. **Set up environment variables**
   Create a `.env` file in the `backend` directory:
   ```env
   # Required
   JWT_SECRET=your_secure_jwt_secret
   DATABASE_URL=postgres://user:password@localhost:5432/cursor3d
   GEMINI_API_KEY=your_gemini_api_key
   GROQ_API_KEY=your_groq_api_key
   
   # Optional
   SKETCHFAB_API_KEY=your_sketchfab_key
   
   # Server Configuration
   PORT=5000
   BLENDER_TCP_HOST=127.0.0.1
   BLENDER_TCP_PORT=9876
   ```

3. **Install dependencies**
   ```bash
   # Install backend dependencies
   cd backend
   npm install
   
   # Install frontend dependencies
   cd ../frontend
   npm install
   ```

4. **Set up Blender**
   - Install the MCP add-on in Blender
   - Configure it to listen on port 9876
   - Start the MCP server in Blender

### Running the Application

1. **Start the backend server**
   ```bash
   cd backend
   npm start
   ```

2. **Start the frontend**
   ```bash
   cd ../frontend
   npm run dev
   ```

3. **Launch Blender**
   - Make sure the MCP add-on is enabled and running
   - The application will automatically connect to Blender

## 🎨 Features in Depth

### Smart Asset Generation
- **Automatic Source Selection**: Chooses the best generation method based on content type
- **Hyper3D Integration**: For photorealistic, high-detail models
- **Asset Library Access**: Direct integration with Sketchfab and PolyHaven
- **Procedural Generation**: Gemini 2.5 Flash generates Blender Python code for custom models

### Dual-Model AI Architecture
- **Gemini 2.5 Flash**: Handles all Blender code generation, scene understanding, and error recovery
- **Groq llama-3.1-8b-instant**: Enhances user prompts with technical details for better generation quality
- **Smart Caching**: Reduces API calls by caching generated code
- **Automatic Error Recovery**: Multi-attempt execution with LLM-powered code repair

### Advanced Workflow
- **Context-Aware Modeling**: Maintains scene state and object relationships
- **Multi-Stage Generation**: Breaks complex tasks into manageable steps
- **Error Recovery**: Automatically detects and fixes common issues
- **Version Control Integration**: Tracks changes and allows for easy rollback

### User Experience
- **Interactive Chat**: Natural language interface for model generation
- **Real-time Preview**: See changes in Blender as they happen
- **History & Versioning**: Access previous generations and modifications
- **Customizable Presets**: Save and reuse generation settings

## 📚 Documentation

### Project Structure
```
CursorFor3D/
├── backend/               # Node.js API server
│   ├── agents/           # AI agents and workflows
│   ├── utils/            # Utility functions
│   └── server.js         # Main server file
├── frontend/             # React + Electron app
│   ├── public/           # Static assets
│   └── src/              # React components
├── docs/                 # Documentation
└── README.md             # This file
```

### API Reference

#### Key Endpoints
- `POST /api/generate` - Generate 3D content from text
- `GET /api/scene` - Get current scene information
- `POST /api/execute` - Execute Blender Python code
- `GET /api/history` - Get generation history

## 🤝 Contributing

We welcome contributions! Please see our [Contributing Guidelines](CONTRIBUTING.md) for details.

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- Blender Foundation for the amazing 3D creation suite
- Google for Gemini 2.5 Flash AI model powering code generation
- Groq for fast prompt enhancement with llama-3.1-8b-instant
- The open-source community for countless libraries and tools
2. Start a conversation by describing what you want to create.
3. Refine your model through continuous chat - ask for modifications, improvements, or changes.
4. Enable prompt enhancement for more detailed and accurate results.
5. Watch your 3D scene come to life in Blender as you iterate!

Troubleshooting
---------------

- **No response from Blender**: check the backend console for messages such as "Blender MCP not connected". Make sure the MCP panel is running on port 9876.
- **Gemini errors**: verify your `GEMINI_API_KEY` is valid. The system uses Gemini 2.5 Flash exclusively for code generation.
- **Groq errors**: verify your `GROQ_API_KEY` is valid. Groq is used for prompt enhancement with llama-3.1-8b-instant model.
- **"get_hyper3d_status is not defined" errors**: The generated code attempted to call integration functions directly in Blender. This is a known issue being addressed - the code should use the socket API instead.
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
