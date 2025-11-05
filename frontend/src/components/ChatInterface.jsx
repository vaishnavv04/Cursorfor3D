import React, { useState, useRef, useEffect } from "react";

const ChatInterface = () => {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [conversationId, setConversationId] = useState(null);
  const [loading, setLoading] = useState(false);
  const [enhancePrompt, setEnhancePrompt] = useState(true);
  const [showEnhanced, setShowEnhanced] = useState(false);
  const [enhancedPromptText, setEnhancedPromptText] = useState("");
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleNewChat = async () => {
    try {
      const res = await fetch("http://localhost:5000/api/conversation/new", {
        method: "POST",
      });
      const data = await res.json();
      setConversationId(data.conversationId);
      setMessages([]);
      setInput("");
      setShowEnhanced(false);
      setEnhancedPromptText("");
    } catch (error) {
      console.error("Failed to create new conversation:", error);
    }
  };

  const handleEnhancePrompt = async (promptText) => {
    if (!promptText.trim()) return;
    
    try {
      const res = await fetch("http://localhost:5000/api/enhance-prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: promptText, conversationId }),
      });
      const data = await res.json();
      if (data.enhanced) {
        setEnhancedPromptText(data.enhanced);
        setShowEnhanced(true);
        return data.enhanced;
      }
    } catch (error) {
      console.error("Failed to enhance prompt:", error);
    }
    return promptText;
  };

  const handleSend = async () => {
    if (!input.trim() || loading) return;

    const userMessage = input.trim();
    setInput("");
    setShowEnhanced(false);
    setEnhancedPromptText("");

    // Add user message to UI immediately
    const newUserMessage = {
      id: Date.now(),
      role: "user",
      content: userMessage,
      timestamp: new Date(),
    };
    setMessages((prev) => [...prev, newUserMessage]);

    setLoading(true);

    try {
      // Enhance prompt if enabled
      let finalPrompt = userMessage;
      if (enhancePrompt) {
        finalPrompt = await handleEnhancePrompt(userMessage);
      }

      const res = await fetch("http://localhost:5000/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: finalPrompt,
          conversationId,
          enhancePrompt: enhancePrompt,
        }),
      });

      const data = await res.json();

      if (res.ok) {
        // Set conversation ID if new
        if (data.conversationId) {
          setConversationId(data.conversationId);
        }

        // Add assistant response
        const assistantMessage = {
          id: Date.now() + 1,
          role: "assistant",
          content: data.response || "",
          timestamp: new Date(),
          blenderResult: data.blenderResult,
          provider: data.provider,
          enhancedPrompt: data.enhancedPrompt,
          sceneContext: data.sceneContext,
        };
        setMessages((prev) => [...prev, assistantMessage]);

        // Show enhanced prompt if available
        if (data.enhancedPrompt && data.enhancedPrompt !== userMessage) {
          setEnhancedPromptText(data.enhancedPrompt);
          setShowEnhanced(true);
        }
      } else {
        // Add error message
        const errorMessage = {
          id: Date.now() + 1,
          role: "assistant",
          content: `Error: ${data.error || "Something went wrong"}`,
          timestamp: new Date(),
          isError: true,
        };
        setMessages((prev) => [...prev, errorMessage]);
      }
    } catch (error) {
      console.error("Error:", error);
      const errorMessage = {
        id: Date.now() + 1,
        role: "assistant",
        content: `Error: Unable to connect to backend. Make sure it's running on port 5000.`,
        timestamp: new Date(),
        isError: true,
      };
      setMessages((prev) => [...prev, errorMessage]);
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  };

  const handleKeyPress = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex flex-col h-screen bg-[#0a0a0a] text-white">
      {/* Header */}
      <div className="border-b border-gray-800/50 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <h1 className="text-xl font-semibold text-white">3D Scene Generator</h1>
          <span className="text-xs text-gray-500 px-2 py-1 rounded bg-gray-900/50">
            {conversationId ? "Active" : "New Chat"}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer">
            <input
              type="checkbox"
              checked={enhancePrompt}
              onChange={(e) => setEnhancePrompt(e.target.checked)}
              className="w-4 h-4 rounded border-gray-600 bg-gray-800 text-blue-500 focus:ring-blue-500"
            />
            <span>Enhance prompts</span>
          </label>
          <button
            onClick={handleNewChat}
            className="px-4 py-2 rounded-lg bg-gray-800 hover:bg-gray-700 text-sm font-medium transition-colors"
          >
            New Chat
          </button>
        </div>
      </div>

      {/* Messages Area */}
      <div className="flex-1 overflow-y-auto px-6 py-6 space-y-6">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center px-4">
            <div className="mb-6">
              <div className="w-16 h-16 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center mb-4">
                <svg
                  className="w-8 h-8 text-white"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01"
                  />
                </svg>
              </div>
            </div>
            <h2 className="text-2xl font-semibold mb-2 text-white">Create 3D Scenes with AI</h2>
            <p className="text-gray-400 max-w-md mb-8">
              Describe what you want to create, and I'll generate Blender Python code to bring it to life.
              You can refine and iterate on your creations through conversation.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 max-w-lg w-full">
              {[
                "Create a realistic rabbit",
                "Make a futuristic cityscape",
                "Design a medieval castle",
                "Generate a forest scene",
              ].map((suggestion, idx) => (
                <button
                  key={idx}
                  onClick={() => setInput(suggestion)}
                  className="px-4 py-3 rounded-lg bg-gray-800/50 hover:bg-gray-800 border border-gray-700/50 text-left text-sm text-gray-300 hover:text-white transition-colors"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((message) => (
            <div
              key={message.id}
              className={`flex gap-4 ${
                message.role === "user" ? "justify-end" : "justify-start"
              }`}
            >
              {message.role === "assistant" && (
                <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center flex-shrink-0">
                  <svg
                    className="w-5 h-5 text-white"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
                    />
                  </svg>
                </div>
              )}
              <div
                className={`max-w-3xl rounded-2xl px-5 py-4 ${
                  message.role === "user"
                    ? "bg-blue-600 text-white"
                    : message.isError
                    ? "bg-red-900/20 border border-red-800/50 text-red-200"
                    : "bg-gray-800/80 border border-gray-700/50 text-gray-100"
                }`}
              >
                {message.role === "user" ? (
                  <p className="whitespace-pre-wrap">{message.content}</p>
                ) : (
                  <div className="space-y-4">
                    {message.enhancedPrompt && message.enhancedPrompt !== message.content && (
                      <div className="mb-3 p-3 rounded-lg bg-blue-900/20 border border-blue-800/50">
                        <p className="text-xs text-blue-300 mb-1 font-medium">Enhanced Prompt:</p>
                        <p className="text-sm text-blue-200">{message.enhancedPrompt}</p>
                      </div>
                    )}
                    {message.sceneContext && (
                      <div className="mb-3 p-3 rounded-lg bg-purple-900/20 border border-purple-800/50">
                        <p className="text-xs text-purple-300 mb-1 font-medium">Scene Context:</p>
                        <p className="text-sm text-purple-200">
                          {message.sceneContext.objects?.length || 0} objects in scene
                        </p>
                      </div>
                    )}
                    {message.provider && (
                      <div className="mb-2">
                        <span className="text-xs px-2 py-1 rounded-full bg-gray-700/50 text-gray-400">
                          {message.provider.toUpperCase()}
                        </span>
                      </div>
                    )}
                    {message.blenderResult && (
                      <div className="mb-3 p-3 rounded-lg bg-green-900/20 border border-green-800/50">
                        <p className="text-xs text-green-300 mb-1 font-medium">Blender Status:</p>
                        <p className="text-sm text-green-200">
                          {message.blenderResult.error
                            ? `Error: ${message.blenderResult.error}`
                            : message.blenderResult.message || "Code executed successfully"}
                        </p>
                      </div>
                    )}
                    {message.content && (
                      <div>
                        <p className="text-xs text-gray-400 mb-2 font-medium">Generated Code:</p>
                        <pre className="text-xs bg-gray-900/50 rounded-lg p-3 overflow-x-auto border border-gray-700/30">
                          <code className="text-gray-300">{message.content}</code>
                        </pre>
                      </div>
                    )}
                  </div>
                )}
                <p className="text-xs mt-2 opacity-60">
                  {new Date(message.timestamp).toLocaleTimeString()}
                </p>
              </div>
              {message.role === "user" && (
                <div className="w-8 h-8 rounded-full bg-gray-700 flex items-center justify-center flex-shrink-0">
                  <svg
                    className="w-5 h-5 text-gray-300"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
                    />
                  </svg>
                </div>
              )}
            </div>
          ))
        )}
        {loading && (
          <div className="flex gap-4 justify-start">
            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center flex-shrink-0">
              <svg
                className="w-5 h-5 text-white animate-spin"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                />
              </svg>
            </div>
            <div className="bg-gray-800/80 border border-gray-700/50 rounded-2xl px-5 py-4">
              <div className="flex gap-2">
                <div className="w-2 h-2 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: "0ms" }}></div>
                <div className="w-2 h-2 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: "150ms" }}></div>
                <div className="w-2 h-2 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: "300ms" }}></div>
              </div>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Enhanced Prompt Preview */}
      {showEnhanced && enhancedPromptText && (
        <div className="px-6 py-3 border-t border-gray-800/50 bg-gray-900/30">
          <div className="max-w-4xl mx-auto flex items-start gap-3">
            <div className="flex-1">
              <p className="text-xs text-blue-400 mb-1 font-medium">Enhanced Prompt:</p>
              <p className="text-sm text-gray-300">{enhancedPromptText}</p>
            </div>
            <button
              onClick={() => setShowEnhanced(false)}
              className="text-gray-500 hover:text-gray-300 transition-colors"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* Input Area */}
      <div className="border-t border-gray-800/50 px-6 py-4 bg-[#0a0a0a]">
        <div className="max-w-4xl mx-auto">
          <div className="flex gap-3 items-end">
            <div className="flex-1 relative">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyPress={handleKeyPress}
                placeholder="Describe what you want to create..."
                rows={1}
                className="w-full px-4 py-3 pr-12 rounded-xl bg-gray-900/80 border border-gray-700/50 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500/50 resize-none max-h-32 overflow-y-auto"
                style={{ minHeight: "48px" }}
              />
              <button
                onClick={handleSend}
                disabled={!input.trim() || loading}
                className="absolute right-2 bottom-2 p-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
              >
                <svg
                  className="w-5 h-5 text-white"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"
                  />
                </svg>
              </button>
            </div>
          </div>
          <p className="text-xs text-gray-500 mt-2 text-center">
            Press Enter to send, Shift+Enter for new line
          </p>
        </div>
      </div>
    </div>
  );
};

export default ChatInterface;

