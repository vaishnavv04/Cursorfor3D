import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../context/AuthContext";

const ChatInterface = () => {
  const { token, user, logout, apiBase } = useAuth();
  const baseUrl = apiBase || "http://localhost:5000";

  const [conversations, setConversations] = useState([]);
  const [conversationId, setConversationId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [conversationsLoading, setConversationsLoading] = useState(true);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [sidebarError, setSidebarError] = useState("");
  const [error, setError] = useState("");
  const [enhancePrompt, setEnhancePrompt] = useState(true);
  const [showEnhanced, setShowEnhanced] = useState(false);
  const [enhancedPromptText, setEnhancedPromptText] = useState("");
  const [attachments, setAttachments] = useState([]);
  const [selectedModel, setSelectedModel] = useState("gemini-2.5-flash");
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  const normalizeMessage = useCallback((message) => ({
    id: message.id,
    role: message.role,
    content: message.content || "",
    timestamp: message.createdAt || message.created_at || new Date().toISOString(),
    provider: message.provider || message.metadata?.model || null,
    blenderResult: message.blenderResult || message.blender_result || null,
    sceneContext: message.sceneContext || message.scene_context || null,
    enhancedPrompt: message.metadata?.enhancedPrompt || null,
    metadata: message.metadata || {},
  }), []);

  const authorizedFetch = useCallback(
    async (path, options = {}) => {
      const headers = {
        ...(options.headers || {}),
        Authorization: `Bearer ${token}`,
      };
      const response = await fetch(`${baseUrl}${path}`, {
        ...options,
        headers,
      });

      if (response.status === 401) {
        logout();
        throw new Error("Session expired");
      }

      return response;
    },
    [baseUrl, token, logout]
  );

  const loadConversation = useCallback(
    async (id, { silent } = {}) => {
      if (!id) return;
      if (!silent) {
        setMessagesLoading(true);
        setMessages([]);
        setShowEnhanced(false);
        setEnhancedPromptText("");
        setAttachments([]);
      }

      try {
        const res = await authorizedFetch(`/api/conversation/${id}`);
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || "Failed to load conversation");
        }

        setConversationId(data.conversation.id);
        setMessages((data.messages || []).map(normalizeMessage));
      } catch (err) {
        console.error("Failed to load conversation", err);
        if (!silent) {
          setError(err.message || "Unable to load conversation");
        }
      } finally {
        if (!silent) {
          setMessagesLoading(false);
        }
      }
    },
    [authorizedFetch, normalizeMessage]
  );

  const fetchConversations = useCallback(async () => {
    if (!token) return;
    setConversationsLoading(true);
    try {
      const res = await authorizedFetch("/api/conversations");
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to load conversations");
      }
      setConversations(data.conversations || []);

      if (!conversationId && data.conversations?.length) {
        await loadConversation(data.conversations[0].id, { silent: true });
      }
      setSidebarError("");
    } catch (err) {
      console.error("Failed to fetch conversations", err);
      setSidebarError(err.message || "Unable to load conversations");
    } finally {
      setConversationsLoading(false);
    }
  }, [authorizedFetch, conversationId, loadConversation, token]);

  useEffect(() => {
    fetchConversations();
  }, [fetchConversations]);

  const deriveTitleFromPrompt = useCallback((prompt) => {
    if (!prompt) return "New Scene";
    const normalized = prompt.replace(/\s+/g, " ").trim();
    if (!normalized) return "New Scene";
    return normalized.length > 64 ? `${normalized.slice(0, 61)}...` : normalized;
  }, []);

  const createConversation = useCallback(
    async (title) => {
      const res = await authorizedFetch("/api/conversation/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to create conversation");
      }
      setConversations((prev) => [data.conversation, ...prev]);
      setConversationId(data.conversation.id);
      return data.conversation;
    },
    [authorizedFetch]
  );

  const handleNewChat = useCallback(async () => {
    try {
      setMessages([]);
      const conversation = await createConversation();
      await loadConversation(conversation.id, { silent: true });
      setShowEnhanced(false);
      setEnhancedPromptText("");
      setInput("");
      setAttachments([]);
    } catch (err) {
      console.error("Failed to start new chat", err);
      setError(err.message || "Unable to create new chat");
    }
  }, [createConversation, loadConversation]);

  const handleEnhancePrompt = useCallback(
    async (promptText, convId) => {
      if (!promptText.trim()) return promptText;
      try {
        const res = await authorizedFetch("/api/enhance-prompt", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: promptText, conversationId: convId || conversationId }),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || "Enhancement failed");
        }
        if (data.enhanced && data.enhanced !== promptText) {
          setEnhancedPromptText(data.enhanced);
          setShowEnhanced(true);
          return data.enhanced;
        }
      } catch (err) {
        console.error("Failed to enhance prompt", err);
      }
      return promptText;
    },
    [authorizedFetch, conversationId]
  );

  const handleSend = useCallback(async () => {
    if (!input.trim() || loading) return;

    const rawPrompt = input.trim();
    setInput("");
    setShowEnhanced(false);
    setEnhancedPromptText("");
    setError("");

    const tempMessage = {
      id: `temp-${Date.now()}`,
      role: "user",
      content: rawPrompt,
      timestamp: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, tempMessage]);
    setLoading(true);

    try {
      let activeConversationId = conversationId;
      if (!activeConversationId) {
        const newConversation = await createConversation(deriveTitleFromPrompt(rawPrompt));
        activeConversationId = newConversation.id;
      }

      let finalPrompt = rawPrompt;
      if (enhancePrompt) {
        finalPrompt = await handleEnhancePrompt(rawPrompt, activeConversationId);
      }

      const payloadAttachments = attachments.map(({ id, name, type, dataUrl, size }) => ({
        id,
        name,
        type,
        dataUrl,
        size,
      }));

      const res = await authorizedFetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: rawPrompt,
          conversationId: activeConversationId,
          enhancePrompt,
          model: selectedModel,
          attachments: payloadAttachments,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Generation failed");
      }

      setConversationId(data.conversationId);
      setMessages((data.messages || []).map(normalizeMessage));
      if (data.enhancedPrompt && data.enhancedPrompt !== rawPrompt) {
        setEnhancedPromptText(data.enhancedPrompt);
        setShowEnhanced(true);
      } else {
        setShowEnhanced(false);
      }
      setAttachments([]);
      fetchConversations();
    } catch (err) {
      console.error("Send error", err);
      setError(err.message || "Unable to generate response");
      setMessages((prev) => [
        ...prev.filter((msg) => !String(msg.id).startsWith("temp-")),
        {
          id: `error-${Date.now()}`,
          role: "assistant",
          content: `Error: ${err.message || "Unable to generate response"}`,
          timestamp: new Date().toISOString(),
          isError: true,
        },
      ]);
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  }, [
    attachments,
    authorizedFetch,
    conversationId,
    createConversation,
    deriveTitleFromPrompt,
    enhancePrompt,
    fetchConversations,
    handleEnhancePrompt,
    input,
    loading,
    normalizeMessage,
    selectedModel,
  ]);

  const handleKeyPress = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const onAttachFiles = async (files) => {
    const toArray = Array.from(files || []);
    const accepted = toArray.filter((f) => f.type.startsWith("image/") || f.type === "application/pdf");
    const readAsDataUrl = (file) =>
      new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
    const loaded = await Promise.all(
      accepted.map(async (f) => ({
        id: `${Date.now()}_${f.name}`,
        name: f.name,
        type: f.type,
        size: f.size,
        dataUrl: await readAsDataUrl(f),
      }))
    );
    setAttachments((prev) => [...prev, ...loaded]);
  };

  const removeAttachment = (id) => setAttachments((prev) => prev.filter((a) => a.id !== id));

  const handleDeleteConversation = useCallback(
    async (id) => {
      try {
        await authorizedFetch(`/api/conversation/${id}`, { method: "DELETE" });
        setConversations((prev) => prev.filter((c) => c.id !== id));
        if (conversationId === id) {
          setConversationId(null);
          setMessages([]);
        }
      } catch (err) {
        console.error("Failed to delete conversation", err);
        setSidebarError(err.message || "Unable to delete conversation");
      }
    },
    [authorizedFetch, conversationId]
  );

  const conversationItems = useMemo(() => {
    return conversations.map((conversation) => {
      const isActive = conversation.id === conversationId;
      const updatedAt = conversation.updatedAt || conversation.updated_at;
      const subtitle = updatedAt ? new Date(updatedAt).toLocaleString() : "";
      return (
        <div
          key={conversation.id}
          role="button"
          tabIndex={0}
          onClick={() => loadConversation(conversation.id)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              loadConversation(conversation.id);
            }
          }}
          className={`w-full text-left px-3 py-2 rounded-lg border transition flex items-center justify-between gap-2 cursor-pointer ${
            isActive ? "border-pink-600/60 bg-pink-600/10" : "border-gray-800 hover:border-gray-700"
          }`}
        >
          <div>
            <p className="text-sm text-white truncate">{conversation.title || "Untitled"}</p>
            {subtitle && <p className="text-xs text-gray-500">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              handleDeleteConversation(conversation.id);
            }}
            className="text-xs text-gray-500 hover:text-red-400"
          >
            ✕
          </button>
        </div>
      );
    });
  }, [conversations, conversationId, handleDeleteConversation, loadConversation]);

  return (
    <div className="flex h-screen bg-[#0a0a0a] text-white">
      <aside className="w-72 border-r border-gray-900/80 bg-[#0b0b0b] flex flex-col">
        <div className="p-4">
          <div className="text-pink-300 font-semibold mb-4">CursorFor3D</div>
          <button
            onClick={handleNewChat}
            className="w-full rounded-lg bg-gradient-to-r from-pink-600 to-purple-600 hover:from-pink-500 hover:to-purple-500 px-4 py-2 text-sm font-medium"
          >
            New Chat
          </button>
        </div>
        <div className="px-4 pb-3">
          <div className="relative">
            <input
              className="w-full rounded-lg bg-gray-950/60 border border-gray-800 px-3 py-2 text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-pink-600/40"
              placeholder="Conversations"
              readOnly
            />
            <span className="absolute right-2 top-2 text-gray-600 text-xs">⌘B</span>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-2 space-y-1">
          {conversationsLoading ? (
            <p className="text-xs text-gray-600 px-2">Loading…</p>
          ) : conversations.length === 0 ? (
            <p className="text-xs text-gray-600 px-2">No threads yet</p>
          ) : (
            conversationItems
          )}
          {sidebarError && <p className="text-xs text-red-400 px-2">{sidebarError}</p>}
        </div>
        <div className="p-4 border-t border-gray-900/80 text-sm text-gray-400">
          <div className="flex flex-col gap-2">
            <span className="text-xs text-gray-500 truncate">{user?.email}</span>
            <button onClick={logout} className="text-left text-sm text-gray-400 hover:text-white">
              Log out
            </button>
          </div>
        </div>
      </aside>

      <div className="flex-1 flex flex-col">
        <div className="border-b border-gray-900/80 px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold text-white">How can I help you?</h1>
            <span className="text-xs text-gray-500 px-2 py-1 rounded bg-gray-900/60">
              {conversationId ? "Active" : "New Chat"}
            </span>
          </div>
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
              <input
                type="checkbox"
                checked={enhancePrompt}
                onChange={(e) => setEnhancePrompt(e.target.checked)}
                className="w-4 h-4 rounded border-gray-600 bg-gray-800 text-blue-500 focus:ring-blue-500"
              />
              <span>Enhance</span>
            </label>
            <select
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              className="bg-gray-900/70 border border-gray-800 rounded-lg px-3 py-1.5 text-xs focus:outline-none"
            >
              <option value="gemini-2.5-flash">Gemini 2.5 Flash</option>
              <option value="llama3-70b-8192">Groq LLaMA3 70B</option>
            </select>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-6 space-y-6">
          {messagesLoading ? (
            <div className="flex items-center justify-center h-full text-gray-500">Loading conversation…</div>
          ) : messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center px-4">
              <div className="mb-6">
                <div className="w-16 h-16 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center mb-4">
                  <svg className="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
                {["Create a realistic rabbit", "Make a futuristic cityscape", "Design a medieval castle", "Generate a forest scene"].map((suggestion, idx) => (
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
              <div key={message.id} className={`flex gap-4 ${message.role === "user" ? "justify-end" : "justify-start"}`}>
                {message.role === "assistant" && (
                  <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center flex-shrink-0">
                    <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
                    <svg className="w-5 h-5 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                    </svg>
                  </div>
                )}
              </div>
            ))
          )}
          {loading && (
            <div className="flex gap-4 justify-start">
              <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center flex-shrink-0">
                <svg className="w-5 h-5 text-white animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
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
          {error && <p className="text-sm text-red-400">{error}</p>}
          <div ref={messagesEndRef} />
        </div>

        {showEnhanced && enhancedPromptText && (
          <div className="px-6 py-3 border-t border-gray-800/50 bg-gray-900/30">
            <div className="max-w-4xl mx-auto flex items-start gap-3">
              <div className="flex-1">
                <p className="text-xs text-blue-400 mb-1 font-medium">Enhanced Prompt:</p>
                <p className="text-sm text-gray-300">{enhancedPromptText}</p>
              </div>
              <button onClick={() => setShowEnhanced(false)} className="text-gray-500 hover:text-gray-300 transition-colors">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
        )}

        <div className="border-t border-gray-900/80 px-6 py-4 bg-[#0a0a0a]">
          <div className="max-w-4xl mx-auto">
            {attachments.length > 0 && (
              <div className="flex gap-3 flex-wrap mb-3">
                {attachments.map((att) => (
                  <div key={att.id} className="group relative border border-gray-800 rounded-lg overflow-hidden bg-gray-900/60">
                    {att.type.startsWith("image/") ? (
                      <img src={att.dataUrl} alt={att.name} className="h-20 w-20 object-cover" />
                    ) : (
                      <div className="h-20 w-28 flex items-center justify-center text-xs text-gray-300 px-2">PDF: {att.name}</div>
                    )}
                    <button
                      onClick={() => removeAttachment(att.id)}
                      className="absolute top-1 right-1 hidden group-hover:block text-gray-300 hover:text-white bg-black/60 rounded p-0.5"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex gap-3 items-end">
              <div className="flex-1 relative">
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyPress={handleKeyPress}
                  placeholder="Describe what you want to create..."
                  rows={1}
                  className="w-full px-4 py-3 pr-24 rounded-xl bg-gray-900/80 border border-gray-800 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-pink-600/40 focus:border-pink-600/40 resize-none max-h-32 overflow-y-auto"
                  style={{ minHeight: "48px" }}
                />
                <label className="absolute right-12 bottom-2 p-2 rounded-lg bg-gray-800 hover:bg-gray-700 cursor-pointer">
                  <input type="file" accept="image/*,application/pdf" className="hidden" multiple onChange={(e) => onAttachFiles(e.target.files)} />
                  <svg className="w-5 h-5 text-gray-200" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828L20 7" />
                  </svg>
                </label>
                <button
                  onClick={handleSend}
                  disabled={!input.trim() || loading}
                  className="absolute right-2 bottom-2 p-2 rounded-lg bg-gradient-to-r from-pink-600 to-purple-600 hover:from-pink-500 hover:to-purple-500 disabled:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
                >
                  <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                  </svg>
                </button>
              </div>
            </div>
            <p className="text-xs text-gray-500 mt-2 text-center">Press Enter to send, Shift+Enter for new line</p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ChatInterface;

