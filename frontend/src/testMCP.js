// src/utils/testMCP.js
export async function testMCPConnection() {
  try {
    const response = await fetch("http://localhost:9876/ping"); // default MCP port
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.text();
    console.log("✅ Blender MCP Connected:", data);
    return true;
  } catch (error) {
    console.error("❌ Blender MCP Not Reachable:", error.message);
    return false;
  }
}
