import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

export default function AuthPage() {
  const [isLogin, setIsLogin] = useState(true);
  const navigate = useNavigate();

  const handleSubmit = (e) => {
    e.preventDefault();
    // mock auth logic
    alert(`${isLogin ? 'Logged in' : 'Account created'} successfully!`);
    navigate('/generate');
  };

  return (
    <div className="bg-black text-white flex justify-center items-center min-h-screen">
      <div className="bg-gray-900 p-10 rounded-xl text-center w-[400px]">
        <h2 className="text-2xl mb-6 font-bold">
          {isLogin ? 'Sign In' : 'Create Account'}
        </h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          {!isLogin && (
            <input
              type="text"
              placeholder="Full Name"
              required
              className="w-full p-3 rounded bg-gray-800 outline-none"
            />
          )}
          <input
            type="email"
            placeholder="Email"
            required
            className="w-full p-3 rounded bg-gray-800 outline-none"
          />
          <input
            type="password"
            placeholder="Password"
            required
            className="w-full p-3 rounded bg-gray-800 outline-none"
          />
          <button
            type="submit"
            className="w-full bg-blue-600 py-3 rounded-lg hover:bg-blue-700 transition"
          >
            {isLogin ? 'Sign In' : 'Sign Up'}
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
          onClick={() => navigate('/generate')}
          className="mt-6 w-full bg-gray-800 py-3 rounded-lg hover:bg-gray-700 flex justify-center items-center space-x-2"
        >
          <span>🔗</span>
          <span>Continue with Google</span>
        </button>
      </div>
    </div>
  );
}

