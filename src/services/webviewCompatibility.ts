// MI8's installed WebView 83 predates Object.hasOwn, used by react-markdown.
// Preserve the native implementation on newer engines.
if (typeof (Object as unknown as { hasOwn?: unknown }).hasOwn !== "function") {
  Object.defineProperty(Object, "hasOwn", {
    value: (object: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(object, key),
    writable: true,
    configurable: true,
  });
}

// A covered native Activity can leave an already-enqueued root-scheduling
// microtask stranded on the MI8's WebView83. New microtasks still work on
// return, but React's scheduled latch prevents it posting the old work again.
// Keep only outstanding jobs and re-enqueue them on an actual resume. A late
// original callback and repeated resume events must never run a job twice.
// This is a lifecycle compatibility repair, not a React-internals reset, UI
// reload, polling loop or change to any native command/data authority.
if (typeof window !== "undefined" && typeof window.queueMicrotask === "function") {
  const userAgent = window.navigator.userAgent;
  const chromium = /Chrome\/(\d+)/.exec(userAgent);
  if (/Android/.test(userAgent) && /; wv\)/.test(userAgent) && chromium && Number(chromium[1]) <= 83) {
    const enqueueNative = window.queueMicrotask.bind(window);
    const pending = new Set<VoidFunction>();
    window.queueMicrotask = (callback: VoidFunction) => {
      if (typeof callback !== "function") throw new TypeError("queueMicrotask callback must be a function");
      const run = () => { if (pending.delete(run)) callback(); };
      pending.add(run);
      try { enqueueNative(run); }
      catch (error) { pending.delete(run); throw error; }
    };
    const resumePending = () => {
      for (const run of Array.from(pending)) enqueueNative(run);
    };
    window.addEventListener("lr:main-resume", resumePending);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") resumePending();
    });
  }
}
