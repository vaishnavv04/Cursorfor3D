import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../context/AuthContext";

import {
  FiMenu,
  FiEdit2,
  FiShare2,
  FiTrash2,
  FiMessageSquare,
  FiPlus,
} from "react-icons/fi";


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
  const [showEnhanced, setShowEnhanced] = useState(false);
  const [enhancedPromptText, setEnhancedPromptText] = useState("");
  const [attachments, setAttachments] = useState([]);
  const [progress, setProgress] = useState([]);
  // Hardcoded to use gemini-2.5-flash as the only model
  const selectedModel = "gemini:gemini-2.5-flash";
  const [enhancing, setEnhancing] = useState(false);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);
  const [collapsed, setCollapsed] = useState(false);
  const [activeChat, setActiveChat] = useState(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef(null);

  const [editingChatId, setEditingChatId] = useState(null);
  const [editedName, setEditedName] = useState(""); 

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

  // No need to fetch models from backend as we're using a single hardcoded model

  const handleRename = useCallback(async (chatId, newName) => {
    if (!newName || !newName.trim()) {
      setEditingChatId(null);
      setEditedName("");
    }
    
    const trimmedName = newName.trim();
    try {
      const res = await authorizedFetch(`/api/conversation/${chatId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: trimmedName }),
      });
      
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to rename conversation");
      }
      
      const data = await res.json();
      setConversations((prev) =>
        prev.map((c) => (c.id === chatId ? { ...c, title: data.conversation.title } : c))
      );
      setEditingChatId(null);
      setEditedName("");
    } catch (err) {
      console.error("Failed to rename conversation", err);
      setSidebarError(err.message || "Unable to rename conversation");
      setEditingChatId(null);
      setEditedName("");
    }
  }, [authorizedFetch]);

  // Handler wired to the "rename" button in UI — it starts the edit mode
  const handleRenameChat = useCallback((id) => {
    const chat = conversations.find((c) => c.id === id);
    setEditedName(chat?.title || "");
    setEditingChatId(id);
  }, [conversations]);

  const handleShareChat = async (id, e) => {
    e?.stopPropagation();
    const chat = conversations.find((c) => c.id === id);
    if (!chat) return;
    
    const textToCopy = JSON.stringify(chat, null, 2);
    
    // Use fallback method which is more reliable
    const textArea = document.createElement("textarea");
    textArea.value = textToCopy;
    textArea.style.position = "fixed";
    textArea.style.left = "-999999px";
    textArea.style.top = "-999999px";
    textArea.style.opacity = "0";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    
    try {
      const successful = document.execCommand('copy');
      if (successful) {
        alert("Chat copied to clipboard!");
      } else {
        // Try modern clipboard API as fallback
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(textToCopy);
          alert("Chat copied to clipboard!");
        } else {
          throw new Error("Copy command failed");
        }
      }
    } catch (err) {
      console.error("Clipboard error:", err);
      // Last resort: show in prompt
      const userInput = prompt("Copy this chat data (Ctrl+C to copy):", textToCopy);
      if (userInput === null) {
        // User cancelled, do nothing
      }
    } finally {
      document.body.removeChild(textArea);
    }
  };

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
      // Don't add to state here - let handleNewChat or fetchConversations handle it
      setConversationId(data.conversation.id);
      return data.conversation;
    },
    [authorizedFetch]
  );


  const creatingNewChatRef = useRef(false);

const handleNewChat = useCallback(async () => {
  if (creatingNewChatRef.current) return;
  creatingNewChatRef.current = true;

  try {
    setMessages([]);
    setConversationId(null);
    const conversation = await createConversation("New Chat");

    
    setConversations((prev) => {
      const exists = prev.some((c) => c.id === conversation.id);
      if (exists) return prev;
      return [conversation, ...prev];
    });

    await loadConversation(conversation.id, { silent: true });

    setShowEnhanced(false);
    setEnhancedPromptText("");
    setInput("");
    setAttachments([]);
    setActiveChat(conversation.id);
  } catch (err) {
    console.error("Failed to start new chat", err);
    setError(err.message || "Unable to create new chat");
  } finally {
    creatingNewChatRef.current = false;
  }
}, [
  createConversation,
  loadConversation,
]);



  const handleEnhancePrompt = useCallback(async () => {
    if (!input.trim() || enhancing || loading) return;
    
    setEnhancing(true);
    setError("");
    try {
      const res = await authorizedFetch("/api/enhance-prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: input.trim(), conversationId }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Enhancement failed");
      }
      if (data.enhancedPrompt && data.enhancedPrompt.trim()) {
        setInput(data.enhancedPrompt.trim());
        inputRef.current?.focus();
      }
    } catch (err) {
      console.error("Failed to enhance prompt", err);
      setError(err.message || "Failed to enhance prompt");
    } finally {
      setEnhancing(false);
    }
  }, [authorizedFetch, conversationId, input, enhancing, loading]);

  const handleSend = useCallback(async () => {
    // Allow sending if there's text OR attachments
    if ((!input.trim() && attachments.length === 0) || loading) return;

    const rawPrompt = input.trim();
    setInput("");
    setShowEnhanced(false);
    setEnhancedPromptText("");
    setError("");

    // If no prompt but has attachments, use a default prompt
    const effectivePrompt = rawPrompt || (attachments.length > 0 ? "Analyze the attached image(s) and generate Blender code to recreate what you see." : "");
    
    if (!effectivePrompt) {
      setError("Please enter a message or attach an image");
      setLoading(false);
      return;
    }

    const tempMessage = {
      id: `temp-${Date.now()}`,
      role: "user",
      content: effectivePrompt,
      timestamp: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, tempMessage]);
    setLoading(true);

    setProgress([]);

    try {
      let activeConversationId = conversationId;
      if (!activeConversationId) {
        const newConversation = await createConversation(deriveTitleFromPrompt(effectivePrompt));
        activeConversationId = newConversation.id;
      }

      let finalPrompt = effectivePrompt;

      // Verify attachments have dataUrl before sending
      const payloadAttachments = attachments.map(({ id, name, type, dataUrl, size }) => {
        if (!dataUrl) {
          console.warn('⚠️ Attachment missing dataUrl:', name);
        }
        return {
          id,
          name,
          type,
          dataUrl,
          size,
        };
      });
      
      console.log('📤 Sending', payloadAttachments.length, 'attachment(s) to backend');
      if (payloadAttachments.length > 0) {
        console.log('📤 First attachment:', {
          name: payloadAttachments[0].name,
          type: payloadAttachments[0].type,
          hasDataUrl: !!payloadAttachments[0].dataUrl,
          dataUrlLength: payloadAttachments[0].dataUrl?.length || 0
        });
      }

      const res = await authorizedFetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: effectivePrompt,
          conversationId: activeConversationId,
          enhancePrompt: false,
          model: selectedModel,
          attachments: payloadAttachments,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setProgress(data.progress || []);
        throw new Error(data.error || "Generation failed");
      }

      setProgress(data.progress || []);
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
    fetchConversations,
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

  const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
  const ACCEPTED_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'application/pdf'];

  const validateFile = (file) => {
    if (!file.type || (!file.type.startsWith("image/") && file.type !== "application/pdf")) {
      return { valid: false, error: `${file.name} is not a supported file type. Please upload images (JPEG, PNG, GIF, WebP) or PDF.` };
    }
    if (file.size > MAX_FILE_SIZE) {
      return { valid: false, error: `${file.name} is too large. Maximum file size is 10MB.` };
    }
    return { valid: true };
  };

  const onAttachFiles = async (files) => {
    if (!files || files.length === 0) return;
    
    const toArray = Array.from(files);
    const validFiles = [];
    const errors = [];

    // Validate all files first
    toArray.forEach((file) => {
      const validation = validateFile(file);
      if (validation.valid) {
        validFiles.push(file);
      } else {
        errors.push(validation.error);
      }
    });

    // Show errors if any
    if (errors.length > 0) {
      alert(errors.join('\n'));
    }

    if (validFiles.length === 0) return;

    const readAsDataUrl = (file) =>
      new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });

    try {
      const loaded = await Promise.all(
        validFiles.map(async (f) => ({
          id: `${Date.now()}_${Math.random()}_${f.name}`,
          name: f.name,
          type: f.type,
          size: f.size,
          dataUrl: await readAsDataUrl(f),
        }))
      );
      setAttachments((prev) => [...prev, ...loaded]);
    } catch (err) {
      console.error("Error reading files:", err);
      setError("Failed to read one or more files. Please try again.");
    }
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    
    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      onAttachFiles(files);
    }
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

  const handleDeleteChat = useCallback(async (id) => {
    if (window.confirm("Delete this chat?")) {
      await handleDeleteConversation(id);
    }
  }, [handleDeleteConversation]);


  return (
    <div className="flex h-screen bg-[#0a0a0a] text-white">
      <aside
       className={`${
       collapsed ? "w-16" : "w-72"
        } bg-[#0b0b0b] border-r border-gray-900/80 flex flex-col transition-all duration-300`}
        >
        {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-gray-900/80">
      <div className="flex items-center gap-2">
      <img
        src="C:\Users\sneha\Cursorfor3D-main\frontend\build\logo.png"
        alt="CursorFor3D"
        className={`${collapsed ? "hidden" : "block"} w-6 h-6 rounded`}
      />
      {!collapsed && (
        <span className="text-blue-300 font-semibold text-sm">
          CursorFor3D
        </span>
      )}
    </div>
    <button
      onClick={() => setCollapsed(!collapsed)}
      className="text-gray-400 hover:text-white transition"
    >
      <FiMenu size={18} />
    </button>
  </div>

  {/* New Chat */}
  <div className="p-3 border-b border-gray-900/80">
    <button
      onClick={handleNewChat}
      className="w-full flex items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 px-3 py-2 text-sm font-medium"
    >
      <FiPlus />
      {!collapsed && "New Chat"}
    </button>
  </div>

  {/* Conversations */}
  <div className="flex-1 overflow-y-auto px-2 py-3 space-y-1">
    {conversationsLoading ? (
      <p
        className={`text-xs text-gray-600 px-2 ${
          collapsed ? "text-center" : ""
        }`}
      >
        Loading…
      </p>
    ) : conversations.length === 0 ? (
      <p
        className={`text-xs text-gray-600 px-2 ${
          collapsed ? "text-center" : ""
        }`}
      >
        No threads yet
      </p>
    ) : (
      conversations.map((chat) => (
        <div
          key={chat.id}
          className={`group flex items-center justify-between px-2 py-2 rounded-lg cursor-pointer transition ${
            activeChat === chat.id
              ? "bg-gray-800/70 text-white"
              : "text-gray-400 hover:bg-gray-900/70 hover:text-white"
          }`}
          onClick={() => {
            setActiveChat(chat.id);
            loadConversation(chat.id);
          }}
        >
          <div className="flex items-center gap-2 truncate flex-1 min-w-0">
            <FiMessageSquare
              className="text-gray-500 flex-shrink-0"
              size={16}
            />
            
            {!collapsed && (
              editingChatId === chat.id ? (
                <input
                  type="text"
                  value={editedName}
                  onChange={(e) => setEditedName(e.target.value)}
                  onBlur={() => handleRename(chat.id, editedName)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleRename(chat.id, editedName);
                    } else if (e.key === "Escape") {
                      setEditingChatId(null);
                      setEditedName("");
                    }
                  }}
                  onClick={(e) => e.stopPropagation()}
                  className="flex-1 bg-gray-800 text-white text-sm px-2 py-1 rounded border border-gray-600 focus:outline-none focus:border-pink-500"
                  autoFocus
                />
              ) : (
                <span className="truncate text-sm text-gray-200">{chat.title || "Untitled"}</span>
              )
            )}
          </div>

          {/* Hover actions */}
          {!collapsed && editingChatId !== chat.id && (
            <div className="hidden group-hover:flex gap-2 text-gray-500">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleRenameChat(chat.id);
                }}
                className="hover:text-pink-400"
              >
                <FiEdit2 size={14} />
              </button>
              <button
                onClick={(e) => {
                  handleShareChat(chat.id, e);
                }}
                className="hover:text-purple-400"
              >
                <FiShare2 size={14} />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleDeleteChat(chat.id);
                }}
                className="hover:text-red-400"
              >
                <FiTrash2 size={14} />
              </button>
            </div>
          )}
        </div>
      ))
    )}
  </div>

  {/* Footer */}
  <div className="border-t border-gray-900/80 p-4 text-sm text-gray-400">
    {!collapsed && (
      <>
        <div className="text-xs text-gray-500 truncate mb-2">
          {user?.email}
        </div>
        <button
          onClick={logout}
          className="text-left text-sm text-gray-400 hover:text-white"
        >
          Log out
        </button>
      </>
    )}
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
          <div className="text-xs text-gray-400">
            Model: gemini-2.5-flash
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-6 space-y-6">
          {/* Progress timeline */}
          {progress && progress.length > 0 && (
            <div className="max-w-3xl mx-auto mb-6">
              <div className="mb-2 flex items-center gap-2">
                <h2 className="text-xs font-semibold tracking-wide text-gray-400 uppercase">Process</h2>
                <span className="text-[10px] px-2 py-0.5 rounded bg-gray-800/60 text-gray-500">{progress.length} step{progress.length!==1?'s':''}</span>
              </div>
              <ol className="space-y-1">
                {progress.map((p, i) => (
                  <li key={i} className="flex items-start gap-2 text-xs text-gray-300">
                    <span className="w-16 text-[10px] text-gray-500">{new Date(p.ts).toLocaleTimeString()}</span>
                    <div className="flex-1 flex flex-col">
                      <div className="flex items-center gap-2">
                        <span className="px-1.5 py-0.5 rounded bg-gray-800/50 text-[10px] text-gray-400 font-mono">{p.step}</span>
                        <span className="text-gray-200">{p.message}</span>
                      </div>
                      {p.data && (
                        <pre className="mt-1 max-h-40 overflow-auto bg-gray-950/40 rounded p-2 text-[10px] text-gray-400 border border-gray-800/50">
                          {JSON.stringify(p.data, null, 2)}
                        </pre>
                      )}
                      {p.error && (
                        <span className="mt-1 text-[10px] text-red-400">{p.error}</span>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          )}
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

        <div 
          className="border-t border-gray-900/80 px-6 py-4 bg-[#0a0a0a]"
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <div className="max-w-4xl mx-auto">
            {attachments.length > 0 && (
              <div className="flex gap-3 flex-wrap mb-3">
                {attachments.map((att) => (
                  <div key={att.id} className="group relative border border-gray-800 rounded-lg overflow-hidden bg-gray-900/60">
                    {att.type.startsWith("image/") ? (
                      <div className="relative">
                        <img src={att.dataUrl} alt={att.name} className="h-24 w-24 object-cover" />
                        <div className="absolute bottom-0 left-0 right-0 bg-black/70 px-1 py-0.5">
                          <p className="text-xs text-white truncate">{att.name}</p>
                          <p className="text-xs text-gray-400">{(att.size / 1024).toFixed(1)} KB</p>
                        </div>
                      </div>
                    ) : (
                      <div className="h-24 w-32 flex flex-col items-center justify-center text-xs text-gray-300 px-2">
                        <svg className="w-8 h-8 mb-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                        </svg>
                        <p className="truncate text-center w-full">{att.name}</p>
                        <p className="text-gray-400">{(att.size / 1024).toFixed(1)} KB</p>
                      </div>
                    )}
                    <button
                      onClick={() => removeAttachment(att.id)}
                      className="absolute top-1 right-1 hidden group-hover:block text-white hover:text-red-400 bg-red-600/80 rounded-full p-1 transition-colors"
                      title="Remove attachment"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className={`flex gap-3 items-end ${isDragging ? 'opacity-50' : ''}`}>
              <div className="flex-1 relative">
                {isDragging && (
                  <div className="absolute inset-0 border-2 border-dashed border-pink-500 rounded-xl bg-pink-500/10 flex items-center justify-center z-10">
                    <div className="text-center">
                      <svg className="w-12 h-12 mx-auto text-pink-400 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                      </svg>
                      <p className="text-pink-400 font-medium">Drop images here</p>
                    </div>
                  </div>
                )}
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyPress={handleKeyPress}
                  placeholder="Describe what you want to create..."
                  rows={1}
                  className="w-full px-4 py-3 pr-32 rounded-xl bg-gray-900/80 border border-gray-800 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-pink-600/40 focus:border-pink-600/40 resize-none max-h-32 overflow-y-auto"
                  style={{ minHeight: "48px" }}
                />
                <button
                  onClick={handleEnhancePrompt}
                  disabled={!input.trim() || enhancing || loading}
                  className="absolute right-24 bottom-2 p-2 rounded-lg bg-gray-800 hover:bg-gray-700 disabled:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
                  title="Enhance prompt"
                >
                  {enhancing ? (
                    <svg className="w-5 h-5 text-gray-200 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                  ) : (
                    <svg className="w-5 h-5 text-gray-200" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                    </svg>
                  )}
                </button>
                <label 
                  className="absolute right-12 bottom-2 p-2 rounded-lg bg-gray-800 hover:bg-gray-700 cursor-pointer transition-colors"
                  title="Upload images or PDFs"
                >
                  <input 
                    ref={fileInputRef}
                    type="file" 
                    accept="image/*,application/pdf" 
                    className="hidden" 
                    multiple 
                    onChange={(e) => {
                      onAttachFiles(e.target.files);
                      // Reset input so same file can be selected again
                      if (fileInputRef.current) {
                        fileInputRef.current.value = '';
                      }
                    }} 
                  />
                  <svg className="w-5 h-5 text-gray-200" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                </label>
                <button
                  onClick={handleSend}
                  disabled={(!input.trim() && attachments.length === 0) || loading}
                  className="absolute right-2 bottom-2 p-2 rounded-lg bg-gradient-to-r from-pink-600 to-purple-600 hover:from-pink-500 hover:to-purple-500 disabled:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
                >
                  <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                  </svg>
                </button>
              </div>
            </div>
            <p className="text-xs text-gray-500 mt-2 text-center">
              Press Enter to send, Shift+Enter for new line • Drag & drop images or click the upload icon
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ChatInterface;