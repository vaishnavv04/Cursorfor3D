import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";

const ThemeContext = createContext({
  theme: "light",
  toggleTheme: () => {},
  setTheme: () => {},
});

const THEME_KEY = "cursorfor3d-theme";

export function ThemeProvider({ children }) {
  const storedPreference = useRef(null);
  const manualOverride = useRef(false);

  const resolveInitialTheme = () => {
    if (typeof window === "undefined") {
      return "light";
    }

    const stored = window.localStorage.getItem(THEME_KEY);
    if (stored === "light" || stored === "dark") {
      storedPreference.current = stored;
      return stored;
    }

    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  };

  const [theme, setThemeState] = useState(resolveInitialTheme);

  useEffect(() => {
    const root = document.documentElement;
    const opposite = theme === "dark" ? "light" : "dark";
    root.classList.remove(opposite);
    root.classList.add(theme);
    if (manualOverride.current) {
      window.localStorage.setItem(THEME_KEY, theme);
      storedPreference.current = theme;
    } else if (storedPreference.current !== null) {
      window.localStorage.setItem(THEME_KEY, theme);
    } else {
      window.localStorage.removeItem(THEME_KEY);
    }
  }, [theme]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = (event) => {
      if (manualOverride.current) {
        return;
      }
      setThemeState(event.matches ? "dark" : "light");
    };

    query.addEventListener("change", handleChange);
    return () => query.removeEventListener("change", handleChange);
  }, []);

  const value = useMemo(
    () => ({
      theme,
      setTheme: (next) => {
        manualOverride.current = true;
        setThemeState((prev) => (typeof next === "function" ? next(prev) : next));
      },
      toggleTheme: () => {
        manualOverride.current = true;
        setThemeState((prev) => (prev === "dark" ? "light" : "dark"));
      },
    }),
    [theme]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}
