import { END, START, StateGraph } from "@langchain/langgraph";

function mergeObjects(existing = {}, update = {}) {
  return { ...existing, ...update };
}

function summarizeCode(code, maxChars = 320) {
  if (!code) return null;
  if (code.length <= maxChars) return code;
  return `${code.slice(0, maxChars)}…`;
}

function deriveHintsFromError(errorMessage = "") {
  const hints = [];
  const lower = errorMessage.toLowerCase();
  if (lower.includes("use_dissolve_degenerate")) {
    hints.push("Remove use_dissolve_degenerate argument from extrude operations in Blender 4.5");
  }
  if (lower.includes("use_accurate_grab")) {
    hints.push("Remove use_accurate_grab from transform operators; it is not supported in Blender 4.5");
  }
  if (lower.includes("context") && lower.includes("incorrect")) {
    hints.push("Ensure the correct object is active/selected and Blender is in the proper mode before running the operator");
  }
  if (lower.includes("convert") && lower.includes("operator")) {
    hints.push("Review operator keyword arguments for deprecated or renamed parameters");
  }
  if (!hints.length) {
    hints.push("Review Blender 4.5 API compatibility and ensure only supported operator arguments are used");
  }
  return hints;
}

function buildRepairPrompt({
  sanitizedCode,
  lastError,
  lastHints = [],
  generationPrompt,
}) {
  const hintSection = lastHints.length
    ? `Hints about the failure:\n- ${lastHints.join("\n- ")}`
    : "";
  return `You are a senior Blender 4.5 Python engineer tasked with fixing code that failed to run.\n\nRules:\n1. Output ONLY executable Blender Python code (no markdown, no comments outside the code).\n2. Always include 'import bpy' at the top.\n3. Do not use deprecated parameters like use_undo, use_global, constraint_axis, use_dissolve_degenerate, or use_accurate_grab.\n4. Ensure the correct context: set active objects, select them, and switch modes before using operators.\n5. Avoid enabling addons at runtime.\n6. If fixing transforms, ensure transform_apply is called with correct arguments.\n\nOriginal user goal:\n${generationPrompt}\n\nLast error from Blender:\n${lastError}\n\n${hintSection}\n\nExisting code to repair:\n${sanitizedCode}\n\nReturn the fully corrected Blender Python code.`;
}

export async function runLangGraphPipeline(options) {
  const {
    generationPrompt,
    provider,
    modelName,
    generateWithProvider,
    sanitizeCode,
    preflightCheck,
    executeInBlender,
    repairWithLLM,
    progress,
    maxRepairs = 2,
    skipExecution = false,
  } = options;

  const workflow = new StateGraph({
    channels: {
      shared: {
        value: mergeObjects,
        default: () => ({ attempts: [], repairAttempts: 0 }),
      },
    },
  });

  workflow.addNode("generate", async ({ shared }) => {
    progress?.add("model_call", "Generating Blender code", {
      provider,
      model: modelName,
    });
    const result = await generateWithProvider(generationPrompt, provider, modelName);
    if (!result?.code) {
      progress?.addError("model_error", "Model returned no code", "Empty response");
      return {
        shared: {
          error: "Model returned empty response",
          provider: result?.provider || provider,
        },
      };
    }
    progress?.add("model_response", "Received code from model", {
      provider: result.provider,
      preview: summarizeCode(result.code, 240),
    });
    return {
      shared: {
        code: result.code,
        provider: result.provider,
      },
    };
  });

  workflow.addNode("preflight", async ({ shared }) => {
    if (!shared.code) {
      return { shared };
    }
    const sanitized = sanitizeCode(shared.code);
    const issues = preflightCheck(sanitized);
    progress?.add("preflight", issues.length ? "Preflight detected issues" : "Preflight passed", {
      issueCount: issues.length,
    });
    return {
      shared: {
        sanitizedCode: sanitized,
        preflightIssues: issues,
      },
    };
  });

  workflow.addNode("execute", async ({ shared }) => {
    if (skipExecution) {
      progress?.add("execution_skipped", "Dry run requested, skipping Blender execution");
      return {
        shared: {
          executionOk: true,
          blenderResult: null,
        },
      };
    }

    if (!shared.sanitizedCode) {
      return {
        shared: {
          executionOk: false,
          lastError: "No sanitized code available for execution",
        },
      };
    }

    const attemptIndex = (shared.totalAttempts || 0) + 1;
    progress?.add("execute_attempt", `Executing code in Blender (attempt ${attemptIndex})`, {
      attempt: attemptIndex,
      provider: shared.provider,
    });

    try {
      const blenderResult = await executeInBlender(shared.sanitizedCode);
      progress?.add("execute_success", "Blender execution succeeded", {
        attempt: attemptIndex,
      });
      return {
        shared: {
          executionOk: true,
          blenderResult,
          attempts: [...(shared.attempts || []), { index: attemptIndex - 1, ok: true, ts: Date.now() }],
          totalAttempts: attemptIndex,
        },
      };
    } catch (err) {
      const message = err?.message || String(err);
      const hints = deriveHintsFromError(message);
      progress?.addError("execute_error", `Blender execution failed (attempt ${attemptIndex})`, message, {
        hints,
      });
      return {
        shared: {
          executionOk: false,
          lastError: message,
          lastHints: hints,
          attempts: [...(shared.attempts || []), { index: attemptIndex - 1, ok: false, error: message, ts: Date.now(), hints }],
          totalAttempts: attemptIndex,
        },
      };
    }
  });

  workflow.addNode("repair", async ({ shared }) => {
    const nextRepairAttempt = (shared.repairAttempts || 0) + 1;
    progress?.add("repair", `Repairing code via LLM (attempt ${nextRepairAttempt})`, {
      error: shared.lastError,
    });
    const repairPrompt = buildRepairPrompt({
      sanitizedCode: shared.sanitizedCode,
      lastError: shared.lastError,
      lastHints: shared.lastHints,
      generationPrompt,
    });
    const repairResult = await repairWithLLM(repairPrompt, provider === "groq");
    if (!repairResult?.code) {
      progress?.addError("repair_failed", "Repair agent returned no code", "Empty repair result");
      return {
        shared: {
          error: shared.lastError || "Repair agent failed",
          repairAttempts: nextRepairAttempt,
        },
      };
    }
    progress?.add("repair_success", "Repair agent produced updated code", {
      preview: summarizeCode(repairResult.code, 200),
    });
    return {
      shared: {
        code: repairResult.code,
        provider: repairResult.provider || shared.provider,
        repairAttempts: nextRepairAttempt,
        executionOk: null,
        lastError: null,
        lastHints: null,
      },
    };
  });

  workflow.addNode("finalize", async ({ shared }) => {
    if (shared.executionOk === false) {
      progress?.addError("finalize_error", "Generation pipeline ended without success", shared.lastError || "Unknown error");
    } else {
      progress?.add("finalize", "Generation pipeline completed", {
        attempts: shared.attempts?.length || 0,
        repairs: shared.repairAttempts || 0,
      });
    }
    return { shared };
  });

  workflow.addEdge(START, "generate");
  workflow.addEdge("generate", "preflight");
  workflow.addEdge("preflight", "execute");
  workflow.addConditionalEdges(
    "execute",
    ({ shared }) => {
      if (shared.executionOk) return "finalize";
      if ((shared.repairAttempts || 0) >= maxRepairs) return "finalize";
      return "repair";
    },
    {
      repair: "repair",
      finalize: "finalize",
    },
  );
  workflow.addEdge("repair", "preflight");
  workflow.addEdge("finalize", END);

  const app = workflow.compile();

  const finalState = await app.invoke({
    shared: {
      provider,
      code: null,
      modelName,
      executionOk: null,
      attempts: [],
      repairAttempts: 0,
    },
  });

  return finalState.shared;
}
