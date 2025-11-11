/**
 * Returns a reusable prompt/context string that can be fed to a Gemini-style model
 * to instruct it how to generate and orchestrate requests to the Hyper3D API.
 *
 * The Hyper3D API key is configured in the Blender addon, not in the backend.
 * The Blender addon functions handle all API authentication internally.
 */
export function getHyper3DPromptContext() {
  return (
    "Hyper3D API Context:\n" +
    "- The Blender addon handles all Hyper3D API calls internally with its configured API key.\n" +
    "- Workflow: Use generate_hyper3d_model_via_text() or generate_hyper3d_model_via_images() in your Blender Python code.\n" +
    "- The addon will submit the generation task, poll for status, and import the result automatically.\n" +
    "- Models available: Gen-2 (high-fidelity, production-ready), Regular (balanced), Detail (intricate geometry), Sketch (fast prototyping).\n" +
    "- For text-to-3D: Call generate_hyper3d_model_via_text(prompt='your description', tier='Gen-2')\n" +
    "- For image-to-3D: Call generate_hyper3d_model_via_images(image_paths=['path/to/image.jpg'], tier='Gen-2')\n" +
    "- Common parameters: tier ('Gen-2', 'Regular', 'Detail', 'Sketch'), material ('PBR' for realistic textures)\n" +
    "- The functions return the imported Blender object, or raise an exception if generation fails.\n" +
    "- Poll job status with poll_rodin_job_status(task_uuid) if needed for custom workflows.\n" +
    "- Best for: unique/custom items, animals, creatures, complex objects that would be hard to model procedurally.\n" +
    "- NOT suitable for: ground planes, entire scenes, simple primitives (use procedural modeling for those).\n"
  );
}
