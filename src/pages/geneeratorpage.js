import React, { useState } from 'react';
import { Link } from 'react-router-dom';

export default function GeneratorPage() {
  const [prompt, setPrompt] = useState('');
  const [response, setResponse] = useState('');
  const [loading, setLoading] = useState(false);

  // Function to call backend API
  const handleGenerate = async () => {
    if (!prompt.trim()) return;

    setLoading(true);
    setResponse(''); // clear previous response

    try {
      // ✅ Update this URL to your actual backend endpoint
      const res = await fetch('http://localhost:5000/api/generate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ prompt }),
      });

      const data = await res.json();

      if (res.ok) {
        setResponse(data.response || 'No response received.');
      } else {
        // ✅ Fixed syntax here
        setResponse(`Error: ${data.error || 'Something went wrong.'}`);
      }
    } catch (error) {
      console.error(error);
      setResponse('⚠ Failed to connect to the backend.');
    }

    setLoading(false);
  };

  // Handle Enter key press
  const handleKeyPress = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleGenerate();
    }
  };

  return (
    <div className="bg-black text-white flex flex-col justify-center items-center min-h-screen px-4">
      <p className="text-gray-400 mb-4">
        Looking for Parametric Mode? We open sourced it!
      </p>
      <h1 className="text-4xl mb-8 font-semibold">What's good?</h1>

      {/* Input + Button */}
      <div className="bg-gray-900 flex items-center p-4 rounded-2xl w-full max-w-[600px]">
        <input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={handleKeyPress}
          placeholder="Speak anything into existence..."
          className="bg-transparent text-white flex-grow outline-none px-2"
        />
        <button
          onClick={handleGenerate}
          className={`px-4 py-2 rounded-full ${
            loading ? 'bg-gray-600 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-700'
          }`}
          disabled={loading}
        >
          {loading ? '...' : '↑'}
        </button>
      </div>

      {/* AI Response */}
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
