import React, { useRef, useState } from "react";
import ChatInterface from "../components/ChatInterface";

const STATUS_TEMPLATE = [
  { id: "prompt", label: "Prompt submitted" },
  { id: "gemini", label: "Generating Blender script" },
  { id: "mcp", label: "Contacting Blender MCP" },
  { id: "execution", label: "Executing in Blender" }
];

export default function GeneratorPage() {
  // Use new chat interface by default
  return <ChatInterface />;
}

// Original UI component (kept for reference, can be removed later)
function OriginalGeneratorPage() {
  const [prompt, setPrompt] = useState("");
  const [imageDataUrl, setImageDataUrl] = useState("");
  const [response, setResponse] = useState("");
  const [blenderResult, setBlenderResult] = useState(null);
  const [modelProvider, setModelProvider] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [statusItems, setStatusItems] = useState(() =>
    STATUS_TEMPLATE.map((item) => ({ ...item, state: "idle", detail: "" }))
  );
  const fileInputRef = useRef(null);

  const resetStatus = () => {
    setStatusItems(STATUS_TEMPLATE.map((item) => ({ ...item, state: "idle", detail: "" })));
  };

  const setStatusState = (id, changes) => {
    setStatusItems((prev) =>
      prev.map((item) =>
        item.id === id
          ? {
              ...item,
              ...changes
            }
          : item
      )
    );
  };

  const handleImageChange = (event) => {
    const file = event.target.files?.[0];
    if (!file) {
      setImageDataUrl("");
      return;
    }

    if (!file.type.startsWith("image/")) {
      setError("Please choose an image file (png, jpg, jpeg or webp).");
      setImageDataUrl("");
      return;
    }

    setError("");
    const reader = new FileReader();
    reader.onload = () => {
      setImageDataUrl(typeof reader.result === "string" ? reader.result : "");
    };
    reader.readAsDataURL(file);
  };

  const clearImage = () => {
    setImageDataUrl("");
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleGenerate = async () => {
    if (!prompt.trim()) {
      setError("Enter a text description to generate.");
      return;
    }

    setLoading(true);
    setError("");
    setResponse("");
  setBlenderResult(null);
  setModelProvider("");
    const initialStatus = STATUS_TEMPLATE.map((item) => {
      if (item.id === "prompt") {
        return { ...item, state: "done", detail: "Prompt captured" };
      }
      if (item.id === "gemini") {
        return { ...item, state: "active", detail: "Calling Gemini" };
      }
      return { ...item, state: "pending", detail: "" };
    });
    setStatusItems(initialStatus);

    try {
      const payload = {
        prompt: prompt.trim(),
      };

      if (imageDataUrl) {
        payload.image = imageDataUrl;
      }

      const res = await fetch("http://localhost:5000/api/generate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (res.ok) {
        const provider = data?.provider || "";
        setResponse(data?.response || "");
        setBlenderResult(data?.blenderResult ?? null);
        setModelProvider(provider);
        const providerDetail = data?.response
          ? provider
            ? `Script generated via ${provider}`
            : "Script generated"
          : "No script returned";
        setStatusState("gemini", { state: "done", detail: providerDetail });
        setStatusState("mcp", { state: "active", detail: "Sending script to Blender" });

        if (data?.blenderResult?.error) {
          const errMessage = data.blenderResult.error.message || JSON.stringify(data.blenderResult.error);
          setError(`Blender error: ${errMessage}`);
          setStatusState("mcp", { state: "done", detail: "Script dispatched" });
          setStatusState("execution", { state: "error", detail: errMessage });
        } else if (data?.blenderResult) {
          const statusMessage = data.blenderResult?.message || "Blender executed the code.";
          setStatusState("mcp", { state: "done", detail: "Script dispatched" });
          setStatusState("execution", { state: "done", detail: statusMessage });
        } else {
          setStatusState("mcp", { state: "error", detail: "Blender MCP did not respond" });
          setStatusState("execution", { state: "pending", detail: "" });
        }

        if (!data?.response && !data?.blenderResult) {
          setError("Backend responded without execution details.");
        }
      } else {
  setModelProvider("");
  setError(data?.error || "Something went wrong while generating.");
  setStatusState("gemini", { state: "error", detail: data?.error || "Model request failed" });
        setStatusState("mcp", { state: "pending" });
        setStatusState("execution", { state: "pending" });
      }
    } catch (err) {
      console.error(err);
  setModelProvider("");
  setError("Unable to reach the backend. Make sure it is running on port 5000.");
      setStatusState("gemini", { state: "error", detail: "Backend unreachable" });
      setStatusState("mcp", { state: "pending" });
      setStatusState("execution", { state: "pending" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-black text-white min-h-screen flex flex-col items-center py-16 px-4">
      <div className="w-full max-w-3xl space-y-6">
        <header className="text-center space-y-2">
          <h1 className="text-4xl font-semibold">Generate 3D Blender Scenes</h1>
          <p className="text-gray-400 text-sm">
            Provide a text description, optionally attach an image, and send it to Gemini + Blender MCP.
          </p>
        </header>

        <section className="bg-gray-900/70 rounded-2xl p-6 space-y-4">
          <label className="block text-sm font-medium text-gray-300" htmlFor="prompt-input">
            Scene description
          </label>
          <textarea
            id="prompt-input"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Create a lush forest clearing with a glowing portal and floating rocks..."
            className="w-full min-h-[120px] resize-none rounded-xl bg-gray-950/90 border border-gray-700/60 px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          />

          <div className="space-y-2">
            <label className="block text-sm font-medium text-gray-300" htmlFor="prompt-image-input">
              Reference image (optional)
            </label>
            <div className="flex flex-col sm:flex-row sm:items-center gap-4">
              <input
                id="prompt-image-input"
                type="file"
                accept="image/*"
                onChange={handleImageChange}
                ref={fileInputRef}
                className="text-sm text-gray-300"
              />
              {imageDataUrl && (
                <button
                  type="button"
                  onClick={clearImage}
                  className="self-start rounded-full bg-gray-800 px-4 py-2 text-sm hover:bg-gray-700"
                >
                  Remove image
                </button>
              )}
            </div>
            {imageDataUrl && (
              <div className="rounded-xl bg-gray-950/80 border border-gray-800 p-4">
                <p className="text-xs uppercase tracking-wide text-gray-500 mb-2">Preview</p>
                <img src={imageDataUrl} alt="Prompt reference" className="max-h-56 w-full object-contain rounded-lg" />
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={handleGenerate}
            disabled={loading}
            className={`w-full rounded-full px-6 py-3 text-base font-medium transition ${
              loading ? "bg-gray-700 text-gray-400 cursor-not-allowed" : "bg-blue-600 hover:bg-blue-500"
            }`}
          >
            {loading ? "Generating..." : "Send to Blender"}
          </button>

          {error && (
            <div className="rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
              {error}
            </div>
          )}
        </section>

        {(blenderResult || response) && (
          <section className="bg-gray-900/70 rounded-2xl p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-medium">Status</h2>
              <button
                type="button"
                onClick={() => {
                  resetStatus();
                  setError("");
                  setBlenderResult(null);
                  setResponse("");
                  setModelProvider("");
                }}
                className="text-xs text-gray-400 hover:text-gray-200 transition"
              >
                Clear panel
              </button>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              {statusItems.map((item) => {
                const state = item.state;
                const baseClasses = "rounded-xl border px-4 py-3 transition";
                let palette = "border-gray-800 bg-gray-950/70 text-gray-300";
                if (state === "done") palette = "border-green-600/40 bg-green-600/10 text-green-200";
                if (state === "active") palette = "border-blue-500/40 bg-blue-600/10 text-blue-200";
                if (state === "error") palette = "border-red-500/40 bg-red-600/10 text-red-200";
                if (state === "pending") palette = "border-gray-800 bg-gray-950/40 text-gray-400";
                if (state === "idle") palette = "border-gray-900 bg-gray-950/40 text-gray-500";

                const badgeLabel =
                  state === "done"
                    ? "Done"
                    : state === "active"
                    ? "In progress"
                    : state === "error"
                    ? "Error"
                    : state === "pending"
                    ? "Pending"
                    : "Idle";

                return (
                  <div key={item.id} className={`${baseClasses} ${palette}`}>
                    <div className="flex items-center justify-between text-sm font-medium">
                      <span>{item.label}</span>
                      <span className="rounded-full border border-current px-2 py-0.5 text-xs uppercase tracking-wide">
                        {badgeLabel}
                      </span>
                    </div>
                    {item.detail && (
                      <p className="mt-2 text-xs leading-relaxed text-inherit/90">{item.detail}</p>
                    )}
                  </div>
                );
              })}
            </div>

            {modelProvider && (
              <div className="rounded-xl border border-purple-500/40 bg-purple-500/10 px-4 py-3 text-xs text-purple-100">
                Model provider: <span className="font-medium uppercase tracking-wide">{modelProvider}</span>
              </div>
            )}

            {blenderResult && (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <h2 className="text-lg font-medium">Blender Status</h2>
                  <span className="text-xs text-gray-500">via MCP</span>
                </div>
                <pre className="overflow-x-auto whitespace-pre-wrap rounded-xl bg-gray-950/80 border border-gray-800 p-4 text-sm text-green-200">
                  <code>{JSON.stringify(blenderResult, null, 2)}</code>
                </pre>
              </div>
            )}

            {response && (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <h2 className="text-lg font-medium">Gemini Script</h2>
                  <span className="text-xs text-gray-500">Forwarded to Blender MCP</span>
                </div>
                <pre className="overflow-x-auto whitespace-pre-wrap rounded-xl bg-gray-950/80 border border-gray-800 p-4 text-sm text-gray-100">
                  <code>{response}</code>
                </pre>
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
