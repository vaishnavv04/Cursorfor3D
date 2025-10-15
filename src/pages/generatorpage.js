import React, { useState } from 'react';
import { Link } from 'react-router-dom';

export default function GeneratorPage() {
  const [prompt, setPrompt] = useState('');
  const [response, setResponse] = useState('');

  const handleGenerate = () => {
    if (!prompt.trim()) return;
    // Mock AI response for now
    setResponse(`✨ Generated 3D concept for: "${prompt}"`);
  };

  return (
    <div className="bg-black text-white flex flex-col justify-center items-center min-h-screen px-4">
      <p className="text-gray-400 mb-4">
        Looking for Parametric Mode? We open sourced it!
      </p>
      <h1 className="text-4xl mb-8 font-semibold">What's good?</h1>
      <div className="bg-gray-900 flex items-center p-4 rounded-2xl w-full max-w-[600px]">
        <input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Speak anything into existence..."
          className="bg-transparent text-white flex-grow outline-none px-2"
        />
        <button
          onClick={handleGenerate}
          className="bg-blue-600 px-4 py-2 rounded-full hover:bg-blue-700"
        >
          ↑
        </button>
      </div>

      {response && (
        <div className="mt-8 bg-gray-800 p-6 rounded-lg w-full max-w-[600px] text-center text-gray-300">
          {response}
        </div>
      )}

      <p className="mt-6 text-gray-400">
        <Link to="/auth" className="text-blue-500 hover:underline">Sign in</Link> or{' '}
        <Link to="/auth" className="text-blue-500 hover:underline">Sign Up</Link> to start generating
      </p>
    </div>
  );
}

