import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

const AuthContext = createContext(null);
const AUTH_TOKEN_KEY = "cf3d_token";
const AUTH_USER_KEY = "cf3d_user";
const API_BASE = process.env.REACT_APP_API_BASE || "http://localhost:5000";

function persistAuth(token, user) {
  localStorage.setItem(AUTH_TOKEN_KEY, token);
  localStorage.setItem(AUTH_USER_KEY, JSON.stringify(user));
}

function clearAuth() {
  localStorage.removeItem(AUTH_TOKEN_KEY);
  localStorage.removeItem(AUTH_USER_KEY);
}

export function AuthProvider({ children }) {
  const [token, setToken] = useState(() => localStorage.getItem(AUTH_TOKEN_KEY));
  const [user, setUser] = useState(() => {
    const stored = localStorage.getItem(AUTH_USER_KEY);
    if (!stored) return null;
    try {
      return JSON.parse(stored);
    } catch (err) {
      console.warn("Failed to parse stored user", err);
      return null;
    }
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!token) {
      setLoading(false);
      return;
    }

    let isMounted = true;

    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/auth/me`, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        if (!res.ok) {
          throw new Error("Token expired");
        }

        const data = await res.json();
        if (isMounted) {
          setUser(data.user);
          persistAuth(token, data.user);
        }
      } catch (err) {
        console.warn("Failed to refresh session", err);
        if (isMounted) {
          setToken(null);
          setUser(null);
          clearAuth();
        }
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    })();

    return () => {
      isMounted = false;
    };
  }, [token]);

  const applyAuthResponse = useCallback(({ token: newToken, user: userPayload }) => {
    if (!newToken || !userPayload) {
      throw new Error("Invalid authentication response");
    }
    setToken(newToken);
    setUser(userPayload);
    persistAuth(newToken, userPayload);
  }, []);

  const signup = useCallback(
    async ({ email, password, displayName }) => {
      const res = await fetch(`${API_BASE}/api/auth/signup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, displayName }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to create account");
      }
      applyAuthResponse(data);
      return data.user;
    },
    [applyAuthResponse]
  );

  const login = useCallback(
    async ({ email, password }) => {
      const res = await fetch(`${API_BASE}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Invalid email or password");
      }
      applyAuthResponse(data);
      return data.user;
    },
    [applyAuthResponse]
  );

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
    clearAuth();
  }, []);

  const value = useMemo(
    () => ({
      token,
      user,
      loading,
      error,
      setError,
      login,
      signup,
      logout,
      apiBase: API_BASE,
    }),
    [token, user, loading, error, login, signup, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
