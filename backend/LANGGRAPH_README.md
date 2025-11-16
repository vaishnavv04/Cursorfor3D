# LangGraph Implementation for CursorFor3D

This document describes the migration from the manual ReAct agent implementation to LangGraph for improved workflow management, state handling, and maintainability.

## Overview

The original CursorFor3D implementation used a manual ReAct (Reason-Act-Observe) loop with custom state management. This has been replaced with a LangGraph-based implementation that provides:

- **Structured Workflow Management**: LangGraph handles the agent workflow with proper state management
- **Better Error Handling**: Built-in error recovery and state persistence
- **Improved Tool Integration**: Standardized tool calling with LangGraph's tool framework
- **Enhanced RAG Integration**: Seamless integration with the existing vector database system
- **Maintainable Architecture**: Cleaner separation of concerns between agent logic and tools

## Architecture

### Core Components

1. **LangGraph Agent** (`langgraph-agent.js`)
   - State management for agent workflow
   - Tool definitions with proper schemas
   - Workflow nodes and conditional routing
   - RAG integration

2. **Updated Server** (`server.js`)
   - Modified `runGenerationCore` to use LangGraph
   - Backward compatibility with existing API
   - Progress tracking integration

3. **Tools System**
   - `search_knowledge_base`: RAG-powered documentation search
   - `get_scene_info`: Blender scene state retrieval
   - `execute_blender_code`: Code execution with sanitization
   - `asset_search_and_import`: Multi-source asset integration
   - `finish_task`: Workflow completion

### State Management

The LangGraph agent maintains the following state:

```javascript
export const AgentState = {
  messages: {
    value: (x, y) => x.concat(y),
    default: () => [],
  },
  sceneContext: {
    default: () => null,
  },
  ragContext: {
    default: () => [],
  },
  integrationStatus: {
    default: () => ({ hyper3d: false, polyhaven: false, sketchfab: false }),
  },
  loopCount: {
    default: () => 0,
  },
  maxLoops: {
    default: () => 10,
  },
  blenderAvailable: {
    default: () => false,
  },
  conversationId: {
    default: () => null,
  },
};
```

## Key Features

### 1. RAG Integration

The LangGraph agent seamlessly integrates with the existing RAG system:

- **Vector Database**: Uses pgvector with Blender API documentation
- **Semantic Search**: Retrieves relevant context based on user queries
- **Context-Aware Responses**: Incorporates RAG results into agent reasoning

### 2. Tool System

All tools are implemented using LangGraph's tool framework:

```javascript
const searchKnowledgeBaseTool = tool(
  async ({ query }) => {
    // Tool implementation
  },
  {
    name: "search_knowledge_base",
    description: "Searches the Blender 4.x API documentation...",
    schema: z.object({
      query: z.string().describe("The search query..."),
    }),
  }
);
```

### 3. Workflow Orchestration

The agent follows a structured workflow:

1. **Agent Node**: Analyzes state and decides next action
2. **Tool Node**: Executes the selected tool
3. **Conditional Routing**: Determines whether to continue or finish
4. **State Updates**: Maintains conversation and scene context

### 4. Multi-Model Support

Supports multiple LLM providers:
- **Gemini 2.5 Flash**: Primary model for reasoning
- **Groq Llama 3.3 70B**: Alternative high-performance option
- **Cohere Command R+**: Additional model choice

## Migration Benefits

### 1. Improved Maintainability
- Clear separation between agent logic and tool implementations
- Standardized state management
- Better error handling and recovery

### 2. Enhanced Performance
- Optimized workflow execution
- Better memory management
- Reduced redundant operations

### 3. Better Debugging
- Structured logging with LangGraph
- State inspection capabilities
- Tool execution tracking

### 4. Extensibility
- Easy to add new tools
- Modular workflow design
- Plugin-friendly architecture

## Usage

### Basic Usage

The API remains unchanged for frontend clients:

```javascript
const response = await fetch('/api/generate', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
  },
  body: JSON.stringify({
    prompt: "Create a realistic dragon with detailed scales",
    conversationId: "optional-conversation-id",
    model: "gemini",
    captureScreenshot: false,
    debug: false,
  }),
});
```

### LangGraph-Specific Features

The response now includes LangGraph-specific metadata:

```javascript
{
  "response": "I have successfully created a red cube...",
  "langGraph": true,
  "agentHistory": [...],
  "loopCount": 3,
  "finished": true,
  "sceneContext": {...},
  "progress": {...}
}
```

## Configuration

### Environment Variables

No additional environment variables are required. The LangGraph implementation uses the same configuration as the original system:

- `GEMINI_API_KEY`: For Gemini model access
- `GROQ_API_KEY`: For Groq model access
- `COHERE_API_KEY`: For Cohere model access
- `DATABASE_URL`: PostgreSQL connection with pgvector

### Dependencies

New dependencies added:

```json
{
  "@langchain/langgraph": "^1.0.1",
  "@langchain/core": "^0.2.0",
  "zod": "^3.22.0"
}
```

## Testing

### Running Tests

```bash
# Test basic import
node -e "import('./langgraph-agent.js').then(() => console.log('✅ Success'))"

# Test agent functionality
node test-langgraph.js
```

### Test Coverage

- ✅ Import and initialization
- ✅ State management
- ✅ Tool execution
- ✅ RAG integration
- ✅ Error handling
- ✅ API compatibility

## Troubleshooting

### Common Issues

1. **Import Errors**
   - Ensure all dependencies are installed
   - Check Node.js version (18+ required)

2. **Tool Execution Failures**
   - Verify Blender connection
   - Check API key configuration
   - Review integration status

3. **RAG Issues**
   - Ensure pgvector extension is enabled
   - Check knowledge base initialization
   - Verify embedding model loading

### Debug Mode

Enable debug mode for detailed execution information:

```javascript
{
  "prompt": "Create a red cube",
  "debug": true,
  "model": "gemini"
}
```

## Future Enhancements

### Planned Improvements

1. **Advanced Tool Chaining**: Support for complex tool sequences
2. **Parallel Tool Execution**: Run multiple tools simultaneously when possible
3. **Dynamic Workflow Selection**: Choose workflows based on prompt analysis
4. **Enhanced State Persistence**: Better state recovery and resume capabilities
5. **Tool Result Caching**: Cache tool results to improve performance

### Extension Points

The LangGraph implementation provides several extension points:

- **Custom Tools**: Easy to add new tools using the tool framework
- **Workflow Variants**: Create specialized workflows for different use cases
- **State Schemas**: Extend state management for new features
- **Middleware**: Add custom processing between workflow steps

## Conclusion

The LangGraph implementation provides a robust, maintainable, and extensible foundation for the CursorFor3D agent system. While maintaining full backward compatibility, it offers significant improvements in workflow management, error handling, and developer experience.

The migration preserves all existing functionality while providing a solid foundation for future enhancements and improvements to the 3D generation workflow.
