import React from 'react';
import Navbar from '../components/navbar';
import { useNavigate } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';

export default function HomePage() {
  const navigate = useNavigate();

  return (
    <div className="bg-black text-white min-h-screen flex flex-col overflow-y-auto">
      <Navbar />

      {/* Hero Section */}
      <div className="flex flex-col items-center justify-center flex-grow min-h-[90vh]">
        <h1 className="text-5xl font-bold text-center mt-10">
          Craft <span className="text-blue-400">Immersive Worlds</span> in Blender
        </h1>
        <button
          onClick={() => navigate('/generate')}
          className="mt-8 bg-blue-600 px-6 py-3 rounded-full hover:bg-blue-700 transition"
        >
          Craft in 3D →
        </button>

        <div
          onClick={() => navigate('/generate')}
          className="mt-10 bg-gray-900 p-6 rounded-lg w-2/3 text-left flex items-center justify-between cursor-pointer hover:bg-gray-800 transition"
        >
          <p className="text-gray-400 text-lg">💡 Turn words into worlds</p>
          <ArrowRight className="text-blue-400" />
        </div>
      </div>

      {/* About Section
      <section id="about" className="min-h-[80vh] p-10 bg-gray-950">
        <h2 className="text-3xl font-semibold mb-4">About</h2>
        <p className="text-gray-400 leading-relaxed">
          Our AI-powered 3D generator transforms text prompts into dynamic 3D scenes,
          revolutionizing how creators visualize and prototype worlds in Blender.
        </p>
      </section> */}

      {/* about Section */}

      <section id="about" className="min-h-screen bg-black text-white p-10 flex flex-col lg:flex-row items-center justify-between">
  {/* Left Side Content */}
  <div className="lg:w-1/2 space-y-6">
    <h1 className="text-5xl font-bold leading-tight text-blue-200">
      The app. <br />
      <span className="text-blue-400"> generate 3D models in seconds.</span>
    </h1>

    <ul className="text-xl mt-8 space-y-4">
      <li className="text-gray-400"></li>
      <li className="text-gray-400"></li>
      <li>
        <span className="font-bold text-white"></span><br />
        <span className="text-gray-400"></span>
      </li>
    </ul>
  </div>

  {/* Right Side Image */}
  <div className="lg:w-1/2 mt-10 lg:mt-0 flex justify-center">
    <img
      src="/path-to-your-uploaded-image.png"
      alt="picture"
      className="rounded-xl shadow-lg max-w-full h-auto"
    />
  </div>
</section>


      {/* Use Cases Section */}
      <section id="usecases" className="min-h-[80vh] p-10 bg-gray-900">
        <h2 className="text-3xl font-semibold mb-4">Use Cases</h2>
        <ul className="text-gray-400 space-y-3">
          <li>🎮 Game Designers – Rapid environment prototyping</li>
          <li>🎥 Animators – Generate background scenes instantly</li>
          <li>🏗️ Architects – Visualize concepts quickly</li>
          <li>🧠 AI Researchers – Test generative 3D capabilities</li>
        </ul>
      </section>

      <section id="Setup" className="min-h-[80vh] p-10 bg-gray-900">
        <h2 className="text-3xl font-semibold mb-4">Setup to use</h2>
        <ul className="text-gray-400 space-y-3">
          <li>How to Use?</li>
          <li></li>
          <li></li>
          <li></li>
        </ul>
      </section>
    </div>
  );
}


