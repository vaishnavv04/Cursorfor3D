import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function AuthPage() {
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const navigate = useNavigate();
  const { login, signup, token } = useAuth();

  useEffect(() => {
    if (token) {
      navigate('/generate', { replace: true });
    }
  }, [token, navigate]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);

    try {
      if (isLogin) {
        await login({ email, password });
      } else {
        await signup({ email, password, displayName });
      }
      navigate('/generate', { replace: true });
    } catch (err) {
      setError(err.message || 'Unable to authenticate.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="bg-black text-white flex justify-center items-center min-h-screen">
      <div className="bg-gray-900 p-10 rounded-xl text-center w-[400px]">
        <h2 className="text-2xl mb-6 font-bold">
          {isLogin ? 'Sign In' : 'Create Account'}
        </h2>

        <form onSubmit={handleSubmit} className="space-y-4 text-left">
          {!isLogin && (
            <input
              type="text"
              placeholder="Display name"
              required
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="w-full p-3 rounded bg-gray-800 outline-none"
              autoComplete="name"
            />
          )}
          <input
            type="email"
            placeholder="Email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full p-3 rounded bg-gray-800 outline-none"
            autoComplete="email"
          />
          <input
            type="password"
            placeholder="Password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full p-3 rounded bg-gray-800 outline-none"
            autoComplete={isLogin ? 'current-password' : 'new-password'}
            minLength={8}
          />
          {error && <p className="text-sm text-red-400">{error}</p>}
          <button
            type="submit"
            disabled={submitting}
            className={`w-full bg-blue-600 py-3 rounded-lg transition ${
              submitting ? 'opacity-70 cursor-not-allowed' : 'hover:bg-blue-700'
            }`}
          >
            {submitting ? 'Please wait…' : isLogin ? 'Sign In' : 'Sign Up'}
          </button>
        </form>

        <p className="mt-6 text-gray-400">
          {isLogin ? (
            <>
              Don't have an account?{' '}
              <button
                onClick={() => setIsLogin(false)}
                className="text-blue-500 hover:underline"
              >
                Sign up
              </button>
            </>
          ) : (
            <>
              Already have an account?{' '}
              <button
                onClick={() => setIsLogin(true)}
                className="text-blue-500 hover:underline"
              >
                Sign in
              </button>
            </>
          )}
        </p>

        <button
          onClick={() => window.open('https://supabase.com/docs/guides/auth', '_blank')}
          className="mt-6 w-full bg-gray-800 py-3 rounded-lg hover:bg-gray-700 flex justify-center items-center space-x-2"
        >
          <span>🔗</span>
          <span>Learn about federated login</span>
        </button>
      </div>
    </div>
  );
}

