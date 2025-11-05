import React from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';

export default function Navbar() {
  const navigate = useNavigate();
  const location = useLocation();

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

  return (
    <nav className="flex justify-between items-center px-10 py-4 bg-black text-white sticky top-0 z-50">
      <img
        src="/logo.png"
        alt="App Logo"
        className="h-auto w-20 cursor-pointer"
        onClick={() => navigate('/')}
      />

      <div className="space-x-6">
        <button onClick={() => scrollToSection('about')} className="hover:text-blue-400">About</button>
        <button onClick={() => scrollToSection('usecases')} className="hover:text-blue-400">Use Cases</button>
        <button onClick={() => scrollToSection('Setup')} className="hover:text-blue-400">Setup</button>
      </div>

      <div className="space-x-4">
        <Link to="/auth" className="hover:text-blue-400">Log In</Link>
        <Link to="/auth" className="bg-blue-600 px-4 py-2 rounded-full text-white hover:bg-blue-700">Sign Up</Link>
      </div>
    </nav>
  );
}
