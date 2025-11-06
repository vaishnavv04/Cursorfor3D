// import logo from './logo.svg';
// import './App.css';

// function App() {
//   return (
//     <div className="App">
//       <header className="App-header">
//         <img src={logo} className="App-logo" alt="logo" />
//         <p>
//           Edit <code>src/App.js</code> and save to reload.
//         </p>
//         <a
//           className="App-link"
//           href="https://reactjs.org"
//           target="_blank"
//           rel="noopener noreferrer"
//         >
//           Learn React
//         </a>
//       </header>
//     </div>
//   );
// }

// export default App;

import React, { useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import HomePage from './pages/homepage';
import AuthPage from './pages/authpage';
import GeneratorPage from './pages/generatorpage';
import { testBlenderConnection } from './testBlender'; // ✅ Added for Blender MCP integration
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

// ✅ Main App Component
export default function App() {
  // ✅ Runs once when the app starts — checks MCP connection
  useEffect(() => {
    testBlenderConnection();
  }, []);

  return (
    // ✅ Router setup, warnings about v7 can be ignored for now
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

// import React from "react";
// import Navbar from "./components/navbar";
// import Home from "./pages/homepage";

// function App() {
//   return (
//     <div className="bg-black min-h-screen">
//       <Navbar />
//       <Home />
//     </div>
//   );
// } 

// export default App;
