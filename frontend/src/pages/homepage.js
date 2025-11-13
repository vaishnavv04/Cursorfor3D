

import React from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useTheme } from "../context/ThemeContext";

export default function HomePage() {
  const navigate = useNavigate();
  const { token } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === 'dark';

  const handleGetStarted = () => {
    if (token) {
      navigate("/generate");
    } else {
      navigate("/auth");
    }
  };

  return (
    <div className="flex flex-col min-h-screen bg-slate-50 text-slate-900 dark:bg-gray-950 dark:text-slate-100 transition-colors">
      {/* Theme Toggle Button */}
      <div className="absolute top-4 right-4">
        <button
          type="button"
          onClick={toggleTheme}
          className="flex items-center justify-center w-10 h-10 rounded-full border border-slate-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-slate-600 dark:text-slate-200 hover:border-blue-500 dark:hover:border-blue-400 transition-colors shadow-sm"
          aria-label={`Switch to ${isDark ? 'light' : 'dark'} theme`}
        >
          {isDark ? (
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="currentColor" viewBox="0 0 20 20">
              <path d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4.22 1.72a1 1 0 011.42 1.42l-.7.7a1 1 0 01-1.42-1.42l.7-.7zM17 9a1 1 0 110 2h-1a1 1 0 110-2h1zM5 10a1 1 0 01-1 1H3a1 1 0 010-2h1a1 1 0 011 1zm1.05-6.05a1 1 0 01.27 1.09l-.33.95a1 1 0 11-1.88-.64l.33-.95A1 1 0 016.05 3.95zM4.22 14.22a1 1 0 011.42 0l.7.7a1 1 0 11-1.42 1.42l-.7-.7a1 1 0 010-1.42zM10 16a1 1 0 011 1v1a1 1 0 11-2 0v-1a1 1 0 011-1zm5.78-1.78a1 1 0 111.42 1.42l-.7.7a1 1 0 11-1.42-1.42l.7-.7zM10 5a5 5 0 100 10A5 5 0 0010 5z" />
            </svg>
          ) : (
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="currentColor" viewBox="0 0 20 20">
              <path d="M17.293 13.293A8 8 0 016.707 2.707a7 7 0 108.586 8.586z" />
            </svg>
          )}
        </button>
      </div>

      <main className="flex flex-col flex-1 justify-center items-center text-center px-4">
      <img
    src="C:\Users\sneha\Cursorfor3D-main\frontend\public\logo.png" // 🔹 replace with your logo path (e.g., "/assets/logo.png" or an imported image)
    alt="Logo"
    className="w-32 h-32 mb-6" // adjust size as needed
  />
        <h1 className="text-5xl font-bold mb-6 tracking-tight leading-tight">
          Cursor for <span className="text-blue-600 dark:text-silver-400">3D</span>
        </h1>

        <p className="text-slate-600 dark:text-slate-300 text-lg mb-10 max-w-xl">
          Generate and design Blender 3D scenes with the power of AI.
        </p>

        <button
          onClick={handleGetStarted}
          className="bg-blue-600 hover:bg-blue-500 dark:hover:bg-blue-500 px-10 py-3 rounded-full text-lg font-semibold text-white shadow-md shadow-blue-600/20 transition-all"
        >
          Get Started →
        </button>
      </main>
    </div>
  );
}
