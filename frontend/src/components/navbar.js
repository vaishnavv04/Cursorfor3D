import React from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';

export default function Navbar() {
  const navigate = useNavigate();
  const location = useLocation();
  const { token, user, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === 'dark';

  const scrollToSection = (id) => {
    if (location.pathname !== '/') {
      navigate('/');
      setTimeout(() => {
        document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
      }, 300);
    } else {
      document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
    }
  };

  const handleLogout = () => {
    logout();
    navigate('/auth');
  };

  return (
    <nav className="flex justify-between items-center px-6 lg:px-10 py-4 bg-white text-slate-900 dark:bg-gray-950 dark:text-white sticky top-0 z-50 border-b border-slate-200 dark:border-gray-800">
      <img
        src="/logo.png"
        alt="App Logo"
        className="h-auto w-20 cursor-pointer"
        onClick={() => navigate('/')}
      />

      <div className="hidden sm:flex items-center gap-4 text-sm font-medium">
        <button onClick={() => scrollToSection('about')} className="hover:text-blue-600 dark:hover:text-blue-400 transition-colors">About</button>
        <button onClick={() => scrollToSection('usecases')} className="hover:text-blue-600 dark:hover:text-blue-400 transition-colors">Use Cases</button>
        <button onClick={() => scrollToSection('Setup')} className="hover:text-blue-600 dark:hover:text-blue-400 transition-colors">Setup</button>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={toggleTheme}
          className="flex items-center justify-center w-10 h-10 rounded-full border border-slate-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-slate-600 dark:text-slate-200 hover:border-blue-500 dark:hover:border-blue-400 transition-colors"
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
        {token ? (
          <>
            <span className="text-sm text-slate-500 dark:text-gray-300 hidden sm:inline">
              {user?.displayName || user?.email}
            </span>
            <button
              onClick={() => navigate('/generate')}
              className="bg-blue-600 px-4 py-2 rounded-full text-white hover:bg-blue-500 transition-colors"
            >
              Open App
            </button>
            <button onClick={handleLogout} className="text-sm text-slate-500 hover:text-slate-900 dark:text-gray-400 dark:hover:text-white transition-colors">
              Log out
            </button>
          </>
        ) : (
          <>
            <Link to="/auth" className="text-sm font-semibold hover:text-blue-600 dark:hover:text-blue-400 transition-colors">
              Log In
            </Link>
            <Link
              to="/auth"
              className="bg-blue-600 px-4 py-2 rounded-full text-white hover:bg-blue-500 transition-colors text-sm font-semibold"
            >
              Sign Up
            </Link>
          </>
        )}
      </div>
    </nav>
  );
}