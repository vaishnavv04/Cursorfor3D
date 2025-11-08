import React, { useEffect } from 'react';
import {
  BrowserRouter as WebRouter,
  HashRouter,
  Routes,
  Route,
  Navigate,
} from 'react-router-dom';
import HomePage from './pages/homepage';
import AuthPage from './pages/authpage';
import GeneratorPage from './pages/generatorpage';
import { testBlenderConnection } from './testBlender';
import { useAuth } from './context/AuthContext';

function ProtectedRoute({ children }) {
  const { token, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-black text-gray-200">
        <p>Loading session…</p>
      </div>
    );
  }

  if (!token) {
    return <Navigate to="/auth" replace />;
  }

  return children;
}

export default function App() {
  const isElectron =
    !!(window && window.process && window.process.versions && window.process.versions.electron);

  useEffect(() => {
    testBlenderConnection();
  }, []);

  const Router = isElectron ? HashRouter : WebRouter;

  return (
    <Router>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/auth" element={<AuthPage />} />
        <Route
          path="/generate"
          element={
            <ProtectedRoute>
              <GeneratorPage />
            </ProtectedRoute>
          }
        />
      </Routes>
    </Router>
  );
}

