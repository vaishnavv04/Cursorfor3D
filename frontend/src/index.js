// import React from 'react';
// import ReactDOM from 'react-dom/client';
// import './index.css';
// import App from './App';
// import reportWebVitals from './reportWebVitals';

// const root = ReactDOM.createRoot(document.getElementById('root'));
// root.render(
//   <React.StrictMode>
//     <App />
//   </React.StrictMode>
// );

// // If you want to start measuring performance in your app, pass a function
// // to log results (for example: reportWebVitals(console.log))
// // or send to an analytics endpoint. Learn more: https://bit.ly/CRA-vitals
// reportWebVitals();

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { AuthProvider } from './context/AuthContext';
import { ThemeProvider } from './context/ThemeContext';

const root = ReactDOM.createRoot(document.getElementById('root'));
const isElectron = !!(window && window.process && window.process.versions && window.process.versions.electron);

const renderApp = () => {
  root.render(
    <ThemeProvider>
    <AuthProvider>
      <App />
    </AuthProvider>
    </ThemeProvider>
  );
};

if (isElectron) {
  renderApp();
} else {
  const DesktopOnly = () => (
    <div style={{
      height: '100vh',
      width: '100vw',
      background: '#0a0a0a',
      color: '#e5e7eb',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      flexDirection: 'column',
      gap: '12px',
      fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Noto Sans, Helvetica Neue, Arial'
    }}>
      <h1 style={{ color: 'white', margin: 0, fontSize: 24 }}>CursorFor3D</h1>
      <p style={{ margin: 0, opacity: 0.8 }}>Desktop only. Please run the Electron app.</p>
    </div>
  );
  root.render(<DesktopOnly />);
}
