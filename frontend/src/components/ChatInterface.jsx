import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../context/AuthContext";
import { useTheme } from "../context/ThemeContext";

import {
  FiMenu,
  FiEdit2,
  FiShare2,
  FiTrash2,
  FiMessageSquare,
  FiPlus,
  FiFolder,
  FiArchive,
} from "react-icons/fi";


const ATTACHMENT_CACHE_KEY = "cursorfor3d:attachment-cache";

const ChatInterface = () => {
  const { token, user, logout, apiBase } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === "dark";
  const baseUrl = apiBase || "http://localhost:5000";

  const [conversations, setConversations] = useState([]);
  const [conversationId, setConversationId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  // auto-resize chat textarea
  useEffect(() => {
    if (inputRef.current) {
      const el = inputRef.current;
      el.style.height = "auto";
      // limit to 300px to avoid covering full screen
      el.style.height = Math.min(el.scrollHeight, 300) + "px";
    }
  }, [input]);
  const [loading, setLoading] = useState(false);
  const [conversationsLoading, setConversationsLoading] = useState(true);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [sidebarError, setSidebarError] = useState("");
  const [error, setError] = useState("");
  const [showEnhanced, setShowEnhanced] = useState(false);
  const [enhancedPromptText, setEnhancedPromptText] = useState("");
  const [attachments, setAttachments] = useState([]);
  const [progress, setProgress] = useState([]);
  const [isConvertingTo3D, setIsConvertingTo3D] = useState(false);
  const [show3DModel, setShow3DModel] = useState(false);
  const [current3DModel, setCurrent3DModel] = useState(null);
  const modelViewerRef = useRef(null);
    // hard-coded model
  const selectedModel = "gemini";
  const [enhancing, setEnhancing] = useState(false);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);
  const [collapsed, setCollapsed] = useState(false);
  const [activeChat, setActiveChat] = useState(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef(null);

  const [editingChatId, setEditingChatId] = useState(null);
  const [editedName, setEditedName] = useState("");
  const attachmentsCacheRef = useRef(new Map());
  const [editingMessage, setEditingMessage] = useState(null);

  const persistAttachmentDataUrl = useCallback((id, dataUrl) => {
    if (!id || !dataUrl || typeof window === "undefined") return;
    attachmentsCacheRef.current.set(id, dataUrl);
    try {
      const raw = window.localStorage.getItem(ATTACHMENT_CACHE_KEY);
      const cache = raw ? JSON.parse(raw) : {};
      cache[id] = dataUrl;
      window.localStorage.setItem(ATTACHMENT_CACHE_KEY, JSON.stringify(cache));
    } catch (err) {
      console.warn("Failed to persist attachment preview", err);
    }
  }, []);

  const loadAttachmentCacheFromStorage = useCallback(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(ATTACHMENT_CACHE_KEY);
      if (!raw) return;
      const cache = JSON.parse(raw);
      if (!cache || typeof cache !== "object") return;
      Object.entries(cache).forEach(([id, dataUrl]) => {
        if (typeof dataUrl === "string" && dataUrl.startsWith("data:")) {
          attachmentsCacheRef.current.set(id, dataUrl);
        }
      });
    } catch (err) {
      console.warn("Failed to load attachment preview cache", err);
    }
  }, []);

  useEffect(() => {
    loadAttachmentCacheFromStorage();
  }, [loadAttachmentCacheFromStorage]);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  const normalizeMessage = useCallback(
    (message) => ({
      id: message.id,
      role: message.role,
      content: message.content || "",
      timestamp: message.createdAt || message.created_at || new Date().toISOString(),
      provider: message.provider || message.metadata?.model || null,
      blenderResult: message.blenderResult || message.blender_result || null,
      sceneContext: message.sceneContext || message.scene_context || null,
      enhancedPrompt: message.metadata?.enhancedPrompt || null,
      metadata: message.metadata || {},
      attachments: (message.metadata?.attachments || message.attachments || []).map((att) => {
        const cachedDataUrl = attachmentsCacheRef.current.get(att.id);
        const dataUrl = cachedDataUrl || att.dataUrl || null;
        if (!cachedDataUrl && att.dataUrl) {
          persistAttachmentDataUrl(att.id, att.dataUrl);
        }
        return {
          ...att,
          dataUrl,
        };
      }),
    }),
    [persistAttachmentDataUrl]
  );

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
        setEditingMessage(null);
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
      setEditingMessage(null);
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
    const originalInputValue = input;
    // Allow sending if there's text OR attachments
    if ((!input.trim() && attachments.length === 0) || loading) return;

    const rawPrompt = input.trim();
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
      attachments: attachments.map((att) => ({
        ...att,
      })),
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
        if (dataUrl) {
          persistAttachmentDataUrl(id, dataUrl);
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
      const normalized = (data.messages || []).map(normalizeMessage);
      // Preserve local data URLs for attachments we still know about
      normalized.forEach((msg) => {
        if (msg.attachments && msg.attachments.length > 0) {
          msg.attachments = msg.attachments.map((att) => ({
            ...att,
            dataUrl: att.dataUrl || attachmentsCacheRef.current.get(att.id) || null,
          }));
          msg.attachments.forEach((att) => {
            if (att.dataUrl) {
              persistAttachmentDataUrl(att.id, att.dataUrl);
            }
          });
        }
      });
      setMessages(normalized);
      // Update conversation title immediately if it was auto-renamed
      if (data.conversationTitle && data.conversationId) {
        setConversations((prev) =>
          prev.map((c) =>
            c.id === data.conversationId ? { ...c, title: data.conversationTitle } : c
          )
        );
      }
      if (data.enhancedPrompt && data.enhancedPrompt !== rawPrompt) {
        setEnhancedPromptText(data.enhancedPrompt);
        setShowEnhanced(true);
      } else {
        setShowEnhanced(false);
      }
      setAttachments([]);
      setInput("");
      setEditingMessage(null);
      fetchConversations();
    } catch (err) {
      console.error("Send error", err);
      setError(err.message || "Unable to generate response");
      setInput(originalInputValue);
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
    persistAttachmentDataUrl,
    selectedModel,
  ]);

  // Convert image to 3D model
  const convertImageTo3D = useCallback(async (file) => {
    if (!file || !file.type.startsWith('image/')) {
      setError("Please select a valid image file");
      return;
    }

    setIsConvertingTo3D(true);
    setError("");

    try {
      // Read file as data URL
      const reader = new FileReader();
      const dataUrl = await new Promise((resolve, reject) => {
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });

      // Create attachment
      const attachment = {
        id: `${Date.now()}_${Math.random()}_${file.name}`,
        name: file.name,
        type: file.type,
        size: file.size,
        dataUrl: dataUrl,
      };

      // Set as attachment and send with prompt
      setAttachments([attachment]);
      setInput("Convert this image to a 3D model using Hyper3D or Sketchfab");
      
      // Auto-send after a brief delay to allow state to update
      setTimeout(() => {
        handleSend();
      }, 100);
    } catch (err) {
      console.error("Error converting image to 3D", err);
      setError("Failed to process image. Please try again.");
    } finally {
      setIsConvertingTo3D(false);
    }
  }, [handleSend]);

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
  const EXTENSION_MIME_MAP = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".pdf": "application/pdf",
  };

  const inferMimeTypeFromName = (name = "") => {
    const lower = name.toLowerCase();
    const match = Object.keys(EXTENSION_MIME_MAP).find((ext) => lower.endsWith(ext));
    return match ? EXTENSION_MIME_MAP[match] : null;
  };

  const validateFile = (file) => {
    const detectedType = (file.type || "").toLowerCase() || inferMimeTypeFromName(file.name);

    if (!detectedType || (!detectedType.startsWith("image/") && detectedType !== "application/pdf")) {
      return {
        valid: false,
        error: `${file.name} is not a supported file type. Please upload images (JPEG, PNG, GIF, WebP) or PDF.`,
      };
    }
    if (file.size > MAX_FILE_SIZE) {
      return { valid: false, error: `${file.name} is too large. Maximum file size is 10MB.` };
    }
    return { valid: true, detectedType };
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
        validFiles.push({ file, detectedType: validation.detectedType || file.type });
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
        validFiles.map(async ({ file, detectedType }) => ({
          id: `${Date.now()}_${Math.random()}_${file.name}`,
          name: file.name,
          type: (detectedType || file.type || inferMimeTypeFromName(file.name) || "application/octet-stream"),
          size: file.size,
          dataUrl: await readAsDataUrl(file),
        }))
      );
      loaded.forEach((att) => {
        if (att.dataUrl) {
          persistAttachmentDataUrl(att.id, att.dataUrl);
        }
      });
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

  const cancelEditing = useCallback(() => {
    setEditingMessage(null);
  }, []);

  const handleEditPrompt = useCallback(
    (message) => {
      if (!message) return;
      const restoredAttachments =
        (message.attachments || []).map((att) => {
          const dataUrl = att.dataUrl || attachmentsCacheRef.current.get(att.id) || null;
          return { ...att, dataUrl };
        }) || [];

      const availableAttachments = restoredAttachments.filter((att) => !!att.dataUrl);
      setInput(message.content || "");
      if (availableAttachments.length !== restoredAttachments.length) {
        setError("Some attachments could not be restored. Please reattach missing files before sending.");
      } else {
        setError("");
      }
      setAttachments(availableAttachments);
      availableAttachments.forEach((att) => {
        if (att.dataUrl) {
          persistAttachmentDataUrl(att.id, att.dataUrl);
        }
      });
      setShowEnhanced(false);
      setEnhancedPromptText("");
      setEditingMessage({
        id: message.id,
        content: message.content || "",
        attachments: restoredAttachments.map((att) => ({
          id: att.id,
          name: att.name,
        })),
      });
      requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    },
    [persistAttachmentDataUrl, setError]
  );

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

  // Helper function to format assistant message content with conversational explanations and collapsible code blocks
  const formatAssistantMessage = useCallback((content) => {
    if (!content) return null;

    // Check if content contains code blocks (markdown-style)
    const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
    const hasCodeBlocks = codeBlockRegex.test(content);

    // If no code blocks, return simple formatted text
    if (!hasCodeBlocks) {
      return (
        <div className="space-y-3">
          <p className="text-sm text-slate-700 dark:text-gray-300 whitespace-pre-wrap break-words">
            {content}
          </p>
        </div>
      );
    }

    // Reset regex
    codeBlockRegex.lastIndex = 0;

    // Split content into parts (text and code blocks)
    const parts = [];
    let lastIndex = 0;
    let match;
    let stepNumber = 1;

    while ((match = codeBlockRegex.exec(content)) !== null) {
      // Add text before code block
      const textBefore = content.substring(lastIndex, match.index).trim();
      if (textBefore) {
        parts.push({ type: 'text', content: textBefore });
      }

      // Add code block
      const language = match[1] || 'python';
      const code = match[2].trim();
      
      // Try to extract a meaningful description from the text before
      let codeDescription = '';
      if (textBefore) {
        // Look for step patterns like "Step 1:", "1.", or sentence before code
        const stepMatch = textBefore.match(/(?:Step\s+\d+[:\-]?\s*|^\d+[\.\)]\s*)(.+?)(?:\.|$)/i);
        if (stepMatch && stepMatch[1]) {
          codeDescription = stepMatch[1].trim();
        } else {
          // Take the last sentence or last 50 chars
          const sentences = textBefore.split(/[.!?]\s+/);
          codeDescription = sentences[sentences.length - 1].trim();
          if (codeDescription.length > 60) {
            codeDescription = codeDescription.substring(0, 57) + '...';
          }
        }
      }
      
      if (!codeDescription) {
        codeDescription = `Step ${stepNumber} – Blender Python code`;
      } else {
        codeDescription = `Step ${stepNumber} – ${codeDescription}`;
      }
      
      parts.push({ type: 'code', language, code, description: codeDescription });
      stepNumber++;
      lastIndex = match.index + match[0].length;
    }

    // Add remaining text after last code block
    const textAfter = content.substring(lastIndex).trim();
    if (textAfter) {
      parts.push({ type: 'text', content: textAfter });
    }

    // If we found code blocks but no text before them, treat the whole thing as a code block
    if (parts.length === 0 || (parts.length === 1 && parts[0].type === 'code')) {
      const simpleCodeMatch = content.match(/```(\w+)?\n([\s\S]*?)```/);
      if (simpleCodeMatch) {
        const language = simpleCodeMatch[1] || 'python';
        const code = simpleCodeMatch[2].trim();
        return (
          <div className="space-y-3">
            <p className="text-sm text-slate-700 dark:text-gray-300 mb-3">
              I'll help you create this 3D scene. Here's the Blender Python code to accomplish this:
            </p>
            <details className="border border-slate-200 dark:border-gray-700 rounded-lg overflow-hidden">
              <summary className="px-4 py-2 bg-slate-100 dark:bg-gray-800 cursor-pointer hover:bg-slate-200 dark:hover:bg-gray-700 text-sm font-medium text-slate-700 dark:text-gray-300">
                Step 1 – Blender Python code
              </summary>
              <pre className="text-xs bg-slate-50 dark:bg-gray-900/50 p-4 overflow-x-auto border-t border-slate-200 dark:border-gray-700">
                <code className="text-slate-800 dark:text-gray-300">{code}</code>
              </pre>
            </details>
          </div>
        );
      }
    }

    // Build structured response
    const elements = [];
    let currentStep = 1;
    let introText = '';

    parts.forEach((part, index) => {
      if (part.type === 'text') {
        // First text block is the introduction
        if (index === 0) {
          introText = part.content;
        } else {
          // Subsequent text blocks are explanations between steps
          elements.push(
            <p key={`text-${index}`} className="text-sm text-slate-700 dark:text-gray-300 mt-3">
              {part.content}
            </p>
          );
        }
      } else if (part.type === 'code') {
        elements.push(
          <details key={`code-${index}`} className="border border-slate-200 dark:border-gray-700 rounded-lg overflow-hidden mt-3">
            <summary className="px-4 py-2 bg-slate-100 dark:bg-gray-800 cursor-pointer hover:bg-slate-200 dark:hover:bg-gray-700 text-sm font-medium text-slate-700 dark:text-gray-300">
              {part.description}
            </summary>
            <pre className="text-xs bg-slate-50 dark:bg-gray-900/50 p-4 overflow-x-auto border-t border-slate-200 dark:border-gray-700">
              <code className="text-slate-800 dark:text-gray-300">{part.code}</code>
            </pre>
          </details>
        );
        currentStep++;
      }
    });

    return (
      <div className="space-y-3">
        {introText && (
          <p className="text-sm text-slate-700 dark:text-gray-300 mb-3">
            {introText}
          </p>
        )}
        {elements}
      </div>
    );
  }, []);

  const primaryNav = useMemo(
    () => [
      { id: "chats", label: "Chats", icon: FiMessageSquare },
    ],
    []
  );

  const sharedGradient = isDark
    ? "bg-gradient-to-b from-[#1c1d26] via-[#12131a] to-[#08090f]"
    : "bg-gradient-to-b from-[#f5f6fb] via-[#e6e9f5] to-[#d8dcee]";

  const pageGradient = `${sharedGradient} ${isDark ? "text-slate-100" : "text-slate-900"}`;

  const sidebarBackground = `${sharedGradient} ${isDark ? "text-white" : "text-slate-900"}`;
  const overlayGradient = `${sharedGradient} ${isDark
    ? "bg-[radial-gradient(circle_at_top,_rgba(94,92,228,0.25),_transparent_60%)]"
    : "bg-[radial-gradient(circle_at_top,_rgba(128,146,255,0.25),_transparent_60%)]"}`;

  const pillBackground = isDark ? "bg-white/5 text-slate-200" : "bg-slate-100 text-slate-600";

  const recentInactiveClasses = isDark
    ? "text-slate-300 hover:bg-white/5 hover:text-white"
    : "text-slate-600 hover:bg-slate-100/80 hover:text-slate-900";

  const recentActiveClasses = isDark ? "bg-white/10 text-white" : "bg-slate-200/90 text-slate-900";

  const footerText = isDark ? "text-slate-400" : "text-slate-500";
  const footerAvatarBg = isDark ? "bg-white/10 text-white" : "bg-slate-200 text-slate-700";

  const logoutButtonClasses = isDark
    ? "text-sm font-medium text-white hover:text-gray-300 transition-colors"
    : "text-sm font-medium text-slate-700 hover:text-slate-900 transition-colors";

  const headerBorder = isDark ? "border-white/5" : "border-slate-200/80";
  const navActiveClasses = isDark
    ? "bg-white/5 text-white shadow-inner shadow-white/10"
    : "bg-slate-200/80 text-slate-900 shadow-inner shadow-slate-300/60";
  const navInactiveClasses = isDark
    ? "text-slate-300 hover:bg-white/5 hover:text-white"
    : "text-slate-600 hover:bg-slate-100 hover:text-slate-900";

  const navIconWrapper = isDark ? "bg-white/5 text-slate-200" : "bg-slate-100 text-slate-600";

  const newChatGradient = isDark
    ? "from-pink-500 to-purple-500 hover:from-pink-400 hover:to-purple-400"
    : "from-pink-400 to-purple-400 hover:from-pink-300 hover:to-purple-300";

  return (
    <div className={`flex h-screen transition-colors ${pageGradient}`}>
      <aside
        className={`${
          collapsed ? "w-16" : "w-60"
        } relative flex h-full flex-col ${sidebarBackground} transition-all duration-300`}
      >
        <div className={`absolute inset-0 ${overlayGradient} pointer-events-none`} />
        <div className="relative flex h-full flex-col">
          {/* Header */}
          <div className={`flex items-center justify-between border-b ${headerBorder} px-6 py-3`}>
            <div className="flex items-center gap-3">
              {!collapsed && (
                <div className="flex flex-col gap-1">
                  <span
                    className={`text-xs uppercase tracking-wider ${
                      isDark ? "text-slate-400" : "text-slate-500"
                    }`}
                  >
                    Dashboard
                  </span>
                  <span className={`text-lg font-semibold ${isDark ? "text-white" : "text-slate-900"}`}>
                    CursorFor3D
                  </span>
                </div>
              )}
            </div>
            <button
              onClick={() => setCollapsed((prev) => !prev)}
              className={`rounded-full border ${isDark ? "border-white/10 text-slate-300 hover:border-white/30 hover:text-white" : "border-slate-200 text-slate-500 hover:border-slate-400 hover:text-slate-700"} p-2 transition`}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
              <FiMenu size={14} />
            </button>
          </div>

          {/* New Chat */}
          <div className={`border-b ${headerBorder} px-3 py-3`}>
            <button
              onClick={handleNewChat}
              className={`w-full rounded-lg bg-gradient-to-r ${newChatGradient} px-3 py-2 text-sm font-semibold text-white shadow-[0_12px_32px_rgba(201,67,55,0.25)] transition`}
            >
              <div className="flex items-center justify-center gap-3">
                <span
                  className={`flex h-4 w-4 items-center justify-center rounded-full ${
                    isDark ? "bg-white/10" : "bg-white/70 text-pink-500"
                  }`}
                >
                  <FiPlus size={14} />
                </span>
                {!collapsed && <span>New chat</span>}
              </div>
            </button>
          </div>

          {/* Primary nav */}
          <nav className="px-2 py-5">
            <div className="space-y-1">
              {primaryNav.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  className={`group flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition ${
                    id === "chats"
                      ? navActiveClasses
                      : navInactiveClasses
                  }`}
                >
                  <span className={`flex h-8 w-8 items-center justify-center rounded-md ${navIconWrapper}`}>
                    <Icon size={16} />
                  </span>
                  {!collapsed && <span>{label}</span>}
                </button>
              ))}
            </div>
          </nav>

          {/* Recents */}
          <div className="flex-1 overflow-y-auto px-2 pb-4">
            {!collapsed && (
              <div
                className={`px-2 pb-2 text-xs font-semibold uppercase tracking-wider ${
                  isDark ? "text-slate-500" : "text-slate-600"
                }`}
              >
                Recents
              </div>
            )}
            <div className="space-y-1">
              {conversationsLoading ? (
                <div className="px-3 py-2 text-xs text-slate-500">Loading…</div>
              ) : conversations.length === 0 ? (
                <div className="px-3 py-2 text-xs text-slate-500">No conversations yet</div>
              ) : (
                conversations.map((chat) => (
                  <div
                    key={chat.id}
                    className={`group rounded-lg px-3 py-2 text-left text-sm transition ${
                      activeChat === chat.id ? recentActiveClasses : recentInactiveClasses
                    }`}
                    onClick={() => {
                      setActiveChat(chat.id);
                      loadConversation(chat.id);
                    }}
                    role="button"
                    tabIndex={0}
                  >
                    <div className="flex items-center gap-3">
                      <span className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md ${navIconWrapper}`}>
                        <FiMessageSquare size={15} />
                      </span>
                      {!collapsed && (
                        <div className="flex min-w-0 flex-1 items-center gap-2">
                          <div className="flex-1 truncate">
                            {editingChatId === chat.id ? (
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
                                className={`w-full rounded-md border ${
                                  isDark
                                    ? "border-white/20 bg-transparent text-white placeholder:text-slate-400 focus:border-white/40"
                                    : "border-slate-200 bg-white text-slate-800 placeholder:text-slate-400 focus:border-slate-400"
                                } px-2 py-1 text-sm focus:outline-none`}
                                autoFocus
                              />
                            ) : (
                              <span className="truncate">{chat.title || "Untitled chat"}</span>
                            )}
                          </div>
                          {editingChatId !== chat.id && (
                            <div
                              className={`flex flex-shrink-0 items-center gap-2 text-xs ${
                                isDark ? "text-slate-400" : "text-slate-500"
                              } opacity-0 transition group-hover:opacity-100`}
                            >
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleRenameChat(chat.id);
                                }}
                                className={isDark ? "hover:text-white" : "hover:text-slate-900"}
                              >
                                <FiEdit2 size={12} />
                              </button>
                              <button
                                onClick={(e) => {
                                  handleShareChat(chat.id, e);
                                }}
                                className={isDark ? "hover:text-white" : "hover:text-slate-900"}
                              >
                                <FiShare2 size={12} />
                              </button>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleDeleteChat(chat.id);
                                }}
                                className={isDark ? "hover:text-red-300" : "hover:text-red-500"}
                              >
                                <FiTrash2 size={12} />
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Footer */}
          <div className={`border-t ${headerBorder} px-4 py-5 text-xs ${footerText}`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className={`flex h-9 w-9 items-center justify-center rounded-full ${footerAvatarBg} text-sm font-semibold uppercase`}>
                  {user?.email?.[0] || "U"}
                </div>
                {!collapsed && (
                  <div className="flex flex-col">
                    <span className={`text-sm font-medium ${isDark ? "text-white" : "text-slate-800"}`}>
                      {user?.email || "Signed in"}
                    </span>
                    <button
                      onClick={logout}
                      className={logoutButtonClasses}
                    >
                     Log out
                    </button>
                    
                  </div>
                )}
              </div>
              {/* {!collapsed && (
                <button
                  onClick={logout}
                  className={logoutButtonClasses}
                >
                  Log out
                </button>
              )} */}
            </div>
          </div>
        </div>
      </aside>


      <div className="flex-1 flex flex-col">
        <div className="border-b border-slate-200 dark:border-gray-900/80 px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold text-slate-900 dark:text-white">Hello! How can I help you?</h1>
            <span className="text-xs text-slate-600 dark:text-gray-400 px-2 py-1 rounded bg-slate-200/80 dark:bg-gray-900/60">
              {conversationId ? "Active" : "New Chat"}
            </span>
          </div>
          <div className="flex items-center gap-3 text-xs text-slate-500 dark:text-gray-500">
                        <button
              type="button"
              onClick={toggleTheme}
              className="flex items-center justify-center w-9 h-9 rounded-full border border-slate-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-slate-600 dark:text-slate-200 hover:border-blue-500 dark:hover:border-blue-400 transition-colors"
              aria-label={`Switch to ${isDark ? "light" : "dark"} theme`}
            >
              {isDark ? (
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4.22 1.72a1 1 0 011.42 1.42l-.7.7a1 1 0 01-1.42-1.42l.7-.7zM17 9a1 1 0 110 2h-1a1 1 0 110-2h1zM5 10a1 1 0 01-1 1H3a1 1 0 010-2h1a1 1 0 011 1zm1.05-6.05a1 1 0 01.27 1.09l-.33.95a1 1 0 11-1.88-.64l.33-.95A1 1 0 016.05 3.95zM4.22 14.22a1 1 0 011.42 0l.7.7a1 1 0 11-1.42 1.42l-.7-.7a1 1 0 010-1.42zM10 16a1 1 0 011 1v1a1 1 0 11-2 0v-1a1 1 0 011-1zm5.78-1.78a1 1 0 111.42 1.42l-.7.7a1 1 0 11-1.42-1.42l.7-.7zM10 5a5 5 0 100 10A5 5 0 0010 5z" />
                </svg>
              ) : (
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M17.293 13.293A8 8 0 016.707 2.707a7 7 0 108.586 8.586z" />
                </svg>
              )}
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-6 space-y-6">
          {messagesLoading ? (
            <div className="flex items-center justify-center h-full text-slate-500 dark:text-gray-500">Loading conversation…</div>
          ) : messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center px-4">
              <div className="mb-6">
                <div className="w-16 h-16 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center mb-4 shadow-lg shadow-blue-500/30">
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
              <h2 className="text-2xl font-semibold mb-2 text-slate-900 dark:text-white">Create 3D Scenes with AI</h2>
              <p className="text-slate-600 dark:text-gray-400 max-w-md mb-8">
                Describe what you want to create, and I'll generate Blender Python code to bring it to life.
                You can refine and iterate on your creations through conversation.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 max-w-lg w-full">
                {["Create a realistic rabbit", "Make a futuristic cityscape", "Design a medieval castle", "Generate a forest scene"].map((suggestion, idx) => (
                  <button
                    key={idx}
                    onClick={() => setInput(suggestion)}
                    className="px-4 py-3 rounded-lg bg-white border border-slate-200 text-left text-sm text-slate-600 hover:bg-slate-100 hover:text-slate-900 transition-colors dark:bg-gray-900/80 dark:border-gray-800 dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-white"
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
                      ? "bg-blue-600 text-white shadow-lg shadow-blue-500/30"
                      : message.isError
                      ? "bg-red-50 text-red-700 border border-red-200 dark:bg-red-900/20 dark:border-red-800/50 dark:text-red-200"
                      : "bg-white border border-slate-200 text-slate-800 dark:bg-gray-800/80 dark:border-gray-700/50 dark:text-gray-100"
                  }`}
                >
                  {message.role === "user" ? (
                    <div className="space-y-3">
                      <div className="flex items-start justify-between gap-3">
                        <p className="whitespace-pre-wrap break-words flex-1">{message.content}</p>
                        <button
                          onClick={() => handleEditPrompt(message)}
                          className="text-blue-100/70 hover:text-white transition-colors"
                          title="Edit and resend this prompt"
                        >
                          <FiEdit2 size={16} />
                        </button>
                      </div>
                      {message.attachments && message.attachments.length > 0 && (
                        <div className="flex gap-3 flex-wrap">
                          {message.attachments.map((att) => (
                            <div
                              key={att.id}
                              className="border border-blue-200/40 bg-blue-500/10 rounded-lg overflow-hidden"
                              style={{ maxWidth: 160 }}
                            >
                              {att.dataUrl ? (
                                att.type?.startsWith("image/") ? (
                                  <img src={att.dataUrl} alt={att.name} className="w-full h-24 object-cover" />
                                ) : (
                                  <div className="w-40 h-24 flex items-center justify-center text-xs text-blue-100 px-2">
                                    <span className="text-center">Attachment</span>
                                  </div>
                                )
                              ) : (
                                <div className="w-40 h-24 flex items-center justify-center text-xs text-blue-100 px-2">
                                  <span className="text-center">Reattach to preview</span>
                                </div>
                              )}
                              <div className="px-2 py-1 bg-blue-900/20 text-xs text-blue-100 truncate">{att.name}</div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="space-y-4">
                      {message.enhancedPrompt && message.enhancedPrompt !== message.content && (
                        <div className="mb-3 p-3 rounded-lg bg-blue-50 border border-blue-200 text-blue-700 dark:bg-blue-900/20 dark:border-blue-800/50 dark:text-blue-200">
                          <p className="text-xs mb-1 font-medium text-blue-600 dark:text-blue-300">Enhanced Prompt:</p>
                          <p className="text-sm text-inherit">{message.enhancedPrompt}</p>
                        </div>
                      )}
                      {message.sceneContext && (
                        <div className="mb-3 p-3 rounded-lg bg-purple-50 border border-purple-200 text-purple-700 dark:bg-purple-900/20 dark:border-purple-800/50 dark:text-purple-200">
                          <p className="text-xs text-purple-600 dark:text-purple-300 mb-1 font-medium">Scene Context:</p>
                          <p className="text-sm text-inherit">
                            {message.sceneContext.objects?.length || 0} objects in scene
                          </p>
                        </div>
                      )}
                      {message.blenderResult && (
                        <div className="mb-3 p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-700 dark:bg-green-900/20 dark:border-green-800/50 dark:text-green-200">
                          <p className="text-xs text-emerald-600 dark:text-green-300 mb-1 font-medium">Blender Status:</p>
                          <p className="text-sm text-inherit">
                            {message.blenderResult.error
                              ? `Error: ${message.blenderResult.error}`
                              : message.blenderResult.message || "Code executed successfully"}
                          </p>
                        </div>
                      )}
                      {message.content && (
                        <div>
                          {formatAssistantMessage(message.content)}
                        </div>
                      )}
                    </div>
                  )}
                  <p className="text-xs mt-2 opacity-60">
                    {new Date(message.timestamp).toLocaleTimeString()}
                  </p>
                </div>
                {message.role === "user" && (
                  <div className="w-8 h-8 rounded-full bg-slate-200 text-slate-600 dark:bg-gray-700 dark:text-gray-300 flex items-center justify-center flex-shrink-0">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
              <div className="bg-white border border-slate-200 rounded-2xl px-5 py-4 shadow-sm dark:bg-gray-800/80 dark:border-gray-700/50">
                <div className="flex gap-2">
                  <div className="w-2 h-2 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: "0ms" }}></div>
                  <div className="w-2 h-2 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: "150ms" }}></div>
                  <div className="w-2 h-2 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: "300ms" }}></div>
                </div>
              </div>
            </div>
          )}
          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
          <div ref={messagesEndRef} />
        </div>

        {showEnhanced && enhancedPromptText && (
          <div className="px-6 py-3 border-t border-slate-200 bg-slate-100 dark:border-gray-800/50 dark:bg-gray-900/30">
            <div className="max-w-4xl mx-auto flex items-start gap-3">
              <div className="flex-1">
                <p className="text-xs text-blue-600 dark:text-blue-400 mb-1 font-medium">Enhanced Prompt:</p>
                <p className="text-sm text-slate-700 dark:text-gray-300">{enhancedPromptText}</p>
              </div>
              <button onClick={() => setShowEnhanced(false)} className="text-slate-500 hover:text-slate-700 dark:text-gray-500 dark:hover:text-gray-300 transition-colors">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
        )}

        <div 
          className="border-t border-slate-200 bg-slate-500 px-6 py-4 dark:border-gray-900/80 dark:bg-[#050816]"
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <div className="max-w-4xl mx-auto">
            {editingMessage && (
              <div className="mb-3 flex items-center justify-between gap-3 px-3 py-2 rounded-lg bg-pink-50 border border-pink-200 text-xs text-pink-700 dark:bg-pink-500/10 dark:border-pink-500/30 dark:text-pink-200">
                <span className="truncate">
                  Editing previous prompt
                  {editingMessage.content
                    ? `: "${editingMessage.content.slice(0, 60)}${editingMessage.content.length > 60 ? "..." : ""}"`
                    : ""}
                </span>
                <button
                  onClick={cancelEditing}
                  className="text-pink-600 hover:text-pink-500 dark:text-pink-200 dark:hover:text-white transition-colors"
                >
                  Cancel
                </button>
              </div>
            )}
            {attachments.length > 0 && (
              <div className="flex gap-3 flex-wrap mb-3">
                {attachments.map((att) => (
                  <div key={att.id} className="group relative border border-slate-200 rounded-lg overflow-hidden bg-slate-100 dark:border-gray-800 dark:bg-gray-900/60">
                    {att.type.startsWith("image/") ? (
                      <div className="relative">
                        <img src={att.dataUrl} alt={att.name} className="h-24 w-24 object-cover" />
                        <div className="absolute bottom-0 left-0 right-0 bg-black/70 px-1 py-0.5">
                          <p className="text-xs text-white truncate">{att.name}</p>
                          <p className="text-xs text-gray-300">{(att.size / 1024).toFixed(1)} KB</p>
                        </div>
                      </div>
                    ) : (
                      <div className="h-24 w-32 flex flex-col items-center justify-center text-xs text-slate-600 dark:text-gray-300 px-2">
                        <svg className="w-8 h-8 mb-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                        </svg>
                        <p className="truncate text-center w-full">{att.name}</p>
                        <p className="text-slate-500 dark:text-gray-400">{(att.size / 1024).toFixed(1)} KB</p>
                      </div>
                    )}
                    <button
                      onClick={() => removeAttachment(att.id)}
                      className="absolute top-1 right-1 hidden group-hover:block text-white hover:text-red-200 bg-red-600/80 rounded-full p-1 transition-colors"
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
                  onKeyDown={handleKeyDown}
                  placeholder="Describe what you want to create..."
                  rows={1}
                  className="w-full px-4 py-3 pr-32 rounded-xl bg-white border border-slate-200 text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-pink-600/40 focus:border-pink-600/40 resize-none max-h-32 overflow-y-auto dark:bg-gray-900/80 dark:border-gray-800 dark:text-white dark:placeholder-gray-500"
                  style={{ minHeight: "48px" }}
                />
                <button
                  onClick={handleEnhancePrompt}
                  disabled={!input.trim() || enhancing || loading}
                  className="absolute right-24 bottom-2 p-2 rounded-lg bg-slate-100 border border-slate-200 text-slate-600 hover:bg-slate-200 disabled:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50 transition-colors dark:bg-gray-800 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-700"
                  title="Enhance prompt"
                >
                  {enhancing ? (
                    <svg className="w-5 h-5 text-slate-600 dark:text-gray-200 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                  ) : (
                    <svg className="w-5 h-5 text-slate-600 dark:text-gray-200" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                    </svg>
                  )}
                </button>
                <div className="absolute right-12 bottom-2 flex gap-1">
                  <label 
                    className="p-2 rounded-lg bg-slate-100 border border-slate-200 text-slate-600 hover:bg-slate-200 cursor-pointer transition-colors dark:bg-gray-800 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-700"
                    title="Upload images"
                  >
                    <input 
                      ref={fileInputRef}
                      type="file" 
                      accept="image/*" 
                      className="hidden" 
                      multiple 
                      onChange={async (e) => {
                        const files = Array.from(e.target.files);
                        // Check if any file is selected
                        if (files.length > 0) {
                          // If it's a single image, ask if user wants to convert to 3D
                          if (files.length === 1 && files[0].type.startsWith('image/')) {
                            if (window.confirm('Do you want to convert this image to a 3D model?')) {
                              await convertImageTo3D(files[0]);
                              // Reset input
                              if (fileInputRef.current) {
                                fileInputRef.current.value = '';
                              }
                              return;
                            }
                          }
                          // If not converting to 3D or multiple files, handle as regular attachments
                          onAttachFiles(e.target.files);
                        }
                        // Reset input so same file can be selected again
                        if (fileInputRef.current) {
                          fileInputRef.current.value = '';
                        }
                      }} 
                    />
                    <svg className="w-5 h-5 text-slate-600 dark:text-gray-200" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                    </svg>
                  </label>
                </div>
                <div className="absolute right-2 bottom-2 flex gap-1">
                  <button
                    onClick={handleSend}
                    disabled={(!input.trim() && attachments.length === 0) || loading || isConvertingTo3D}
                    className="p-2 rounded-lg bg-gradient-to-r from-pink-600 to-purple-600 hover:from-pink-500 hover:to-purple-500 disabled:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
                    title="Send message"
                  >
                    <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                    </svg>
                  </button>
                  {isConvertingTo3D && (
                    <div className="absolute -top-8 right-0 bg-gray-800 text-white text-xs px-2 py-1 rounded">
                      Converting to 3D...
                    </div>
                  )}
                </div>
              </div>
            </div>
            {/* <p className="text-xs text-slate-500 dark:text-gray-500 mt-2 text-center">
              Press Enter to send, Shift+Enter for new line • Drag & drop images or click the upload icon
            </p> */}
          </div>
        </div>
      </div>
    </div>
  );
};

export default ChatInterface;