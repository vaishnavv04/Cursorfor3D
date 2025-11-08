export function createProgressTracker() {
  const steps = [];

  function buildEntry(step, message, data = undefined, error = undefined) {
    const entry = {
      id: `${Date.now()}-${steps.length}`,
      step,
      message,
      ts: Date.now(),
    };
    if (data !== undefined) {
      entry.data = data;
    }
    if (error !== undefined && error !== null) {
      entry.error = typeof error === "string" ? error : String(error);
    }
    steps.push(entry);
    return entry;
  }

  function add(step, message, data) {
    return buildEntry(step, message, data);
  }

  function addError(step, message, error, data) {
    return buildEntry(step, message, data, error);
  }

  function merge(step, entryPatch) {
    const latestIndex = steps.slice().reverse().findIndex((item) => item.step === step);
    if (latestIndex === -1) {
      return add(step, entryPatch?.message || "", entryPatch?.data);
    }
    const actualIndex = steps.length - 1 - latestIndex;
    const existing = steps[actualIndex];
    steps[actualIndex] = {
      ...existing,
      ...entryPatch,
      data: entryPatch?.data !== undefined ? entryPatch.data : existing.data,
      error: entryPatch?.error !== undefined ? entryPatch.error : existing.error,
    };
    return steps[actualIndex];
  }

  return {
    steps,
    add,
    addError,
    merge,
  };
}
