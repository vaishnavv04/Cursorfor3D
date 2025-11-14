/*
 * hyper3d.js
 *
 * "Dumb" module for Hyper3D integration logic.
 * Exports functions that receive 'sendCommand' from the main integration index.
 * Does not contain any TCP connection, client, or standalone logic.
 */

/**
 * Polls for Hyper3D job completion
 * @param {Function} sendCommandFn - The 'sendCommand' function passed from the core module.
 * @param {string} subscriptionKey - The subscription key to check.
 * @param {object} progress - Optional progress tracker object.
 * @returns {Promise<object|void>} - Resolves when the job is complete.
 */
export async function pollHyper3DJob(sendCommandFn, subscriptionKey, progress = null) {
    const POLL_INTERVAL_MS = 5000;
    const JOB_TIMEOUT_MS = 180000; // 3 minutes
    const startTime = Date.now();
    
    // Log start of polling
    if (progress) {
        progress.add("hyper3d_poll_start", "Polling Hyper3D job", { subKey: subscriptionKey.slice(0, 10) + "..." });
    } else {
        console.log(`   -> Polling job (sub key: ${subscriptionKey}) every ${POLL_INTERVAL_MS / 1000}s...`);
    }

    while (Date.now() - startTime < JOB_TIMEOUT_MS) {
        try {
            const statusRes = await sendCommandFn("poll_rodin_job_status", { subscription_key: subscriptionKey });
            
            if (statusRes.status_list) {
                // Check for 'Done'
                if (statusRes.status_list.every(s => s === 'Done')) { 
                    if (progress) {
                        progress.merge("hyper3d_poll_start", { message: "Hyper3D job succeeded" });
                    } else {
                        console.log("   -> Job succeeded.");
                    }
                    return; // Success
                }
                
                if (statusRes.status_list.some(s => s === 'failed')) {
                    throw new Error("Hyper3D job failed (one or more tasks failed)");
                }
                
                if (progress) {
                    progress.add("hyper3d_poll_wait", "Hyper3D job running...", { currentStatus: statusRes.status_list.join(", ") });
                } else {
                    console.log(`   -> Job status: [${statusRes.status_list.join(', ')}]...`);
                }
            } else {
                // Fallback for fal.ai or other modes
                if (statusRes.status === 'succeeded') {
                    if (progress) {
                        progress.merge("hyper3d_poll_start", { message: "Hyper3D job (fal.ai) succeeded", data: statusRes.result });
                    } else {
                        console.log("   -> Job succeeded.");
                    }
                    return statusRes.result; // Success
                }
                if (statusRes.status === 'failed') {
                     throw new Error(statusRes.error || "Hyper3D job failed");
                }
                
                if (progress) {
                    progress.add("hyper3d_poll_wait", "Hyper3D job running...", { currentStatus: statusRes.status });
                } else {
                    console.log(`   -> Job status: ${statusRes.status}...`);
                }
            }
            await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
        } catch (err) {
            if (progress) {
                progress.addError("hyper3d_poll_error", "Polling failed", err?.message || String(err));
            }
            throw err;
        }
    }

    throw new Error("Hyper3D job timed out after 3 minutes");
}

/**
 * Orchestrates the full Hyper3D generation and import flow.
 * @param {Function} sendCommand - The 'sendCommand' function from the core module.
 * @param {string} prompt - The user's text prompt.
 * @param {object} progress - Optional progress tracker object.
 * @returns {Promise<object>} - Resolves with { name, type, assetType }.
 */
export async function generateAndImportAsset(sendCommand, prompt, progress) {
  try {
    // 1. Create job
    const job = await sendCommand("create_rodin_job", { text_prompt: prompt });
    const subscriptionKey = job.jobs?.subscription_key;
    const taskUuid = job.uuid;
    
    if (!subscriptionKey || !taskUuid) {
      throw new Error("Addon did not return jobs.subscription_key or uuid.");
    }
    
    // 2. Poll for job completion
    await pollHyper3DJob(sendCommand, subscriptionKey, progress);
    
    // 3. Import the generated asset
    const importResult = await sendCommand("import_generated_asset", { 
      task_uuid: taskUuid, 
      name: prompt
    });
    
    if (!importResult.succeed || !importResult.name) {
      throw new Error(`Failed to import Hyper3D asset: ${importResult.error || JSON.stringify(importResult)}`);
    }
    
    return { name: importResult.name, type: "Hyper3D", assetType: "models" };
  } catch (error) {
    throw error;
  }
}