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
export async function pollHyper3DJob(sendCommandFn, identifier, progress = null, isFalAi = false) {
    const POLL_INTERVAL_MS = 5000;
    const JOB_TIMEOUT_MS = 180000; // 3 minutes
    const startTime = Date.now();
    
    // Log start of polling
    if (progress) {
        progress.add("hyper3d_poll_start", "Polling Hyper3D job", { identifier: identifier.slice(0, 10) + "..." });
    } else {
        console.log(`   -> Polling job (${isFalAi ? 'request_id' : 'sub key'}: ${identifier}) every ${POLL_INTERVAL_MS / 1000}s...`);
    }

    while (Date.now() - startTime < JOB_TIMEOUT_MS) {
        try {
            // Use appropriate parameter based on mode
            const statusRes = isFalAi 
                ? await sendCommandFn("poll_rodin_job_status", { request_id: identifier })
                : await sendCommandFn("poll_rodin_job_status", { subscription_key: identifier });
            
            // Handle MAIN_SITE format (status_list)
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
            } 
            // Handle FAL_AI format (status field)
            else if (statusRes.status) {
                if (statusRes.status === 'succeeded' || statusRes.status === 'completed') {
                    if (progress) {
                        progress.merge("hyper3d_poll_start", { message: "Hyper3D job (fal.ai) succeeded", data: statusRes.result });
                    } else {
                        console.log("   -> Job succeeded.");
                    }
                    return statusRes.result || statusRes; // Success
                }
                if (statusRes.status === 'failed' || statusRes.status === 'error') {
                     throw new Error(statusRes.error || statusRes.message || "Hyper3D job failed");
                }
                
                if (progress) {
                    progress.add("hyper3d_poll_wait", "Hyper3D job running...", { currentStatus: statusRes.status });
                } else {
                    console.log(`   -> Job status: ${statusRes.status}...`);
                }
            }
            // Unknown format
            else {
                console.warn(`   -> Unknown status format: ${JSON.stringify(statusRes)}`);
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
    
    // Check for error response
    if (job.error) {
      throw new Error(`Hyper3D job creation failed: ${job.error}`);
    }
    
    // Handle both MAIN_SITE and FAL_AI response formats
    // MAIN_SITE format: { jobs: { subscription_key: "..." }, uuid: "..." }
    // FAL_AI format: { request_id: "..." } or similar
    let subscriptionKey = null;
    let taskUuid = null;
    let requestId = null;
    let isFalAi = false;
    
    if (job.jobs?.subscription_key && job.uuid) {
      // MAIN_SITE format
      subscriptionKey = job.jobs.subscription_key;
      taskUuid = job.uuid;
    } else if (job.request_id) {
      // FAL_AI format
      requestId = job.request_id;
      isFalAi = true;
    } else {
      // Try to extract from alternative response structures
      subscriptionKey = job.subscription_key || job.jobs?.subscription_key;
      taskUuid = job.uuid || job.task_uuid;
      requestId = job.request_id || job.id;
      
      if (!subscriptionKey && !requestId) {
        throw new Error(`Addon did not return valid job identifiers. Response: ${JSON.stringify(job)}`);
      }
      
      if (requestId && !subscriptionKey) {
        isFalAi = true;
      }
    }
    
    // 2. Poll for job completion
    if (isFalAi) {
      // For FAL_AI, use request_id for polling
      await pollHyper3DJob(sendCommand, requestId, progress, true);
    } else {
      // For MAIN_SITE, use subscription_key for polling
      await pollHyper3DJob(sendCommand, subscriptionKey, progress, false);
    }
    
    // 3. Import the generated asset
    let importResult;
    if (isFalAi) {
      importResult = await sendCommand("import_generated_asset", { 
        request_id: requestId, 
        name: prompt
      });
    } else {
      importResult = await sendCommand("import_generated_asset", { 
        task_uuid: taskUuid, 
        name: prompt
      });
    }
    
    if (!importResult.succeed || !importResult.name) {
      throw new Error(`Failed to import Hyper3D asset: ${importResult.error || JSON.stringify(importResult)}`);
    }
    
    return { name: importResult.name, type: "Hyper3D", assetType: "models" };
  } catch (error) {
    throw error;
  }
}