import React, { useState } from "react";

export default function AuthModal({ onClose, type = "login" }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const handleSubmit = (e) => {
    e.preventDefault();

    // Simple validation
    if (!email || !password) {
      alert("Please fill in both fields!");
      return;
    }

    // Mock authentication
    if (type === "login") {
      alert(`Welcome back, ${email}!`);
    } else {
      alert(`Account created for ${email}`);
    }

    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-70 flex justify-center items-center z-50">
      <div className="bg-gray-900 p-8 rounded-xl w-[350px] shadow-lg text-white">
        <h2 className="text-2xl font-bold mb-6 text-center text-brand">
          {type === "login" ? "Sign In" : "Sign Up"}
        </h2>

        <form onSubmit={handleSubmit} className="flex flex-col space-y-4">
          <input
            type="email"
            placeholder="Email"
            className="px-4 py-2 rounded bg-gray-800 focus:outline-none border border-gray-700"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <input
            type="password"
            placeholder="Password"
            className="px-4 py-2 rounded bg-gray-800 focus:outline-none border border-gray-700"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button
            type="submit"
            className="bg-brand py-2 rounded-lg hover:bg-brand-dark text-white font-semibold"
          >
            {type === "login" ? "Login" : "Create Account"}
          </button>
        </form>

        <button
          onClick={onClose}
          className="mt-4 w-full text-sm text-gray-400 hover:text-white"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
