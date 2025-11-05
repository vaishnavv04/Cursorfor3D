import React, { useState } from "react";
import { ArrowRight } from "lucide-react";
import { useNavigate } from "react-router-dom";

export default function PromptCard({ onSubmit }) {
  const navigate = useNavigate();
  const [prompt, setPrompt] = useState("");

  const handleSubmit = () => {
    if (!prompt.trim()) return alert("Please enter a command!");
    
    // Send prompt to parent or MCP handler
    if (onSubmit) onSubmit(prompt);

    // Optionally navigate to generate page
    navigate('/generate', { state: { userPrompt: prompt } });
    setPrompt("");
  };

  return (
    <div className="mt-10 bg-gray-900 p-6 rounded-lg w-2/3 flex items-center justify-between transition">
      <input
        type="text"
        placeholder="💡 Turn words into worlds"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        className="flex-1 bg-gray-800 text-white px-4 py-2 rounded mr-4 focus:outline-none"
      />
      <button
        onClick={handleSubmit}
        className="bg-blue-600 px-4 py-2 rounded hover:bg-blue-700 flex items-center"
      >
        <ArrowRight className="text-white" />
      </button>
    </div>
  );
}
