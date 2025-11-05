// 🔹 testBlender.js
// This checks if Blender MCP server is reachable on localhost

export async function testBlenderConnection() {
  try {
    const response = await fetch("http://localhost:9876/ping"); // default MCP port
    if (response.ok) {
      console.log("✅ Connected to Blender MCP:", await response.text());
    } else {
      console.error("⚠️ Blender MCP responded with an error:", response.status);
    }
  } catch (err) {
    console.error("❌ Could not connect to Blender MCP:", err.message);
  }
}
