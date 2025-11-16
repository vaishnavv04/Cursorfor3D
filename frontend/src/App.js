import React, { useEffect, lazy, Suspense } from 'react';
import {
  BrowserRouter as WebRouter,
  HashRouter,
  Routes,
  Route,
  Navigate,
} from 'react-router-dom';
import { testBlenderConnection } from './testBlender';
import { useAuth } from './context/AuthContext';

// Lazy load pages for better performance
const HomePage = lazy(() => import('./pages/homepage'));
const AuthPage = lazy(() => import('./pages/authpage'));
const GeneratorPage = lazy(() => import('./pages/generatorpage'));

// Loading spinner component
function LoadingSpinner() {
  return (
    <div className="flex items-center justify-center min-h-screen bg-black text-gray-200">
      <div className="text-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-gray-200 mx-auto mb-4"></div>
        <p>Loading...</p>
      </div>
    </div>
  );
}

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
      <Suspense fallback={<LoadingSpinner />}>
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
      </Suspense>
    </Router>
  );
}

