// Node.js test for Local Note Autosave Coordinator with Shared Drain Promise (M2.8 P1-A)
import test from "node:test";
import assert from "node:assert/strict";
import { LocalNoteAutosaveCoordinator, type NoteSnapshot } from "../src/services/localNoteAutosave.ts";

test("LocalNoteAutosaveCoordinator — basic edit and debounced save", async () => {
  const saves: NoteSnapshot[] = [];
  const coordinator = new LocalNoteAutosaveCoordinator(
    "n1",
    { title: "Init", content: "", tags: [] },
    async (snap) => {
      saves.push(snap);
    },
    50
  );

  assert.equal(coordinator.isDirty(), false);
  assert.equal(coordinator.getStatus(), "saved");

  coordinator.updateSnapshot({ title: "Edit 1", content: "Body 1", tags: ["tag1"] });
  assert.equal(coordinator.isDirty(), true);
  assert.equal(coordinator.getStatus(), "unsaved");

  await new Promise((r) => setTimeout(r, 80));

  assert.equal(saves.length, 1);
  assert.equal(saves[0].title, "Edit 1");
  assert.equal(coordinator.isDirty(), false);
  assert.equal(coordinator.getStatus(), "saved");
  coordinator.dispose();
});

test("LocalNoteAutosaveCoordinator — shared Drain Promise ensures separate finalFlush waits for Edit B while Save A is running", async () => {
  const saves: NoteSnapshot[] = [];
  let resolveSaveA: () => void = () => {};

  const coordinator = new LocalNoteAutosaveCoordinator(
    "n1",
    { title: "Init", content: "", tags: [] },
    async (snap) => {
      saves.push(snap);
      if (snap.title === "Edit A") {
        await new Promise<void>((resolve) => {
          resolveSaveA = resolve;
        });
      }
    },
    100
  );

  // 1. Edit A & start save A
  coordinator.updateSnapshot({ title: "Edit A", content: "Body A", tags: [] });
  const saveAPromise = coordinator.flush();

  assert.equal(coordinator.getStatus(), "saving");
  assert.equal(saves.length, 1);
  assert.equal(saves[0].title, "Edit A");

  // 2. User types Edit B while Save A is still running in flight
  coordinator.updateSnapshot({ title: "Edit B", content: "Body B", tags: ["new"] });
  assert.equal(coordinator.isDirty(), true);

  // 3. User presses Back (simulating navigation flush while A is running)
  let finalFlushResolved = false;
  const finalFlushPromise = coordinator.flush().then(() => {
    finalFlushResolved = true;
  });

  // 4. Assert finalFlushPromise is STILL PENDING because B is not saved yet
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(finalFlushResolved, false, "finalFlush must not resolve until Edit B is persisted");

  // 5. Complete Save A
  resolveSaveA();

  // 6. Wait for finalFlushPromise to complete
  await finalFlushPromise;

  // 7. Assert Save B was executed in the same drain loop and final state is B
  assert.equal(saves.length, 2);
  assert.equal(saves[1].title, "Edit B");
  assert.equal(saves[1].content, "Body B");
  assert.equal(coordinator.isDirty(), false);
  assert.equal(coordinator.getStatus(), "saved");
  coordinator.dispose();
});

test("LocalNoteAutosaveCoordinator — flush waits until latest edit generation is saved", async () => {
  const saves: NoteSnapshot[] = [];
  const coordinator = new LocalNoteAutosaveCoordinator(
    "n1",
    { title: "Init", content: "", tags: [] },
    async (snap) => {
      saves.push(snap);
    },
    500
  );

  coordinator.updateSnapshot({ title: "Quick 1", content: "", tags: [] });
  coordinator.updateSnapshot({ title: "Quick 2", content: "", tags: [] });
  coordinator.updateSnapshot({ title: "Quick 3", content: "Final", tags: ["f"] });

  // Flush before 500ms debounce — only the newest snapshot is persisted
  const ok = await coordinator.flush();
  assert.equal(ok, true);
  assert.equal(saves.length, 1);
  assert.equal(saves[0].title, "Quick 3");
  assert.equal(saves[0].content, "Final");
  assert.equal(coordinator.isDirty(), false);
  assert.equal(coordinator.getStatus(), "saved");
  coordinator.dispose();
});

test("LocalNoteAutosaveCoordinator — failed save rejects shared Drain Promise and keeps error status", async () => {
  let attempts = 0;
  const coordinator = new LocalNoteAutosaveCoordinator(
    "n1",
    { title: "Init", content: "", tags: [] },
    async () => {
      attempts += 1;
      throw new Error("Disk write failed");
    },
    50
  );

  coordinator.updateSnapshot({ title: "Fail edit", content: "", tags: [] });

  const flush1 = coordinator.flush();
  const flush2 = coordinator.flush();

  await assert.rejects(async () => {
    await Promise.all([flush1, flush2]);
  }, /Disk write failed/);

  assert.equal(attempts, 1, "Single-flight IPC call per drain loop");
  assert.equal(coordinator.getStatus(), "error");
  assert.equal(coordinator.getLastError(), "Disk write failed");
  assert.equal(coordinator.isDirty(), true);
  coordinator.dispose();
});

test("LocalNoteAutosaveCoordinator — mid-drain follow-up save failure rejects a later final flush", async () => {
  let failB = false;
  const saves: NoteSnapshot[] = [];
  let resolveSaveA: () => void = () => {};
  const coordinator = new LocalNoteAutosaveCoordinator(
    "n1",
    { title: "Init", content: "", tags: [] },
    async (snap) => {
      saves.push(snap);
      if (snap.title === "Edit A") {
        await new Promise<void>((resolve) => {
          resolveSaveA = resolve;
        });
        return;
      }
      if (failB) {
        throw new Error("Disk write failed on B");
      }
    },
    100
  );

  coordinator.updateSnapshot({ title: "Edit A", content: "Body A", tags: [] });
  const flushA = coordinator.flush();
  assert.equal(saves.length, 1, "save A started");

  coordinator.updateSnapshot({ title: "Edit B", content: "Body B", tags: [] });
  failB = true; // B's required follow-up save will fail

  const finalFlush = coordinator.flush();
  let finalFlushResolved = false;
  void finalFlush.then(
    () => {
      finalFlushResolved = true;
    },
    () => {
      finalFlushResolved = true;
    }
  );
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(finalFlushResolved, false, "final flush stays pending while the drain runs");

  resolveSaveA();

  await assert.rejects(async () => {
    await finalFlush;
  }, /Disk write failed on B/);
  // flushA joined the same drain and also rejects
  await assert.rejects(async () => {
    await flushA;
  }, /Disk write failed on B/);

  assert.equal(coordinator.getStatus(), "error");
  assert.equal(coordinator.isDirty(), true, "coordinator remains dirty so navigation can keep the editor open");
  coordinator.dispose();
});

test("LocalNoteAutosaveCoordinator — multiple flush triggers (debounce + blur + back) lock single-flight", async () => {
  let callCount = 0;
  const coordinator = new LocalNoteAutosaveCoordinator(
    "n1",
    { title: "Init", content: "", tags: [] },
    async () => {
      callCount += 1;
      await new Promise((r) => setTimeout(r, 20));
    },
    50
  );

  coordinator.updateSnapshot({ title: "Multi-trigger", content: "", tags: [] });

  // Simultaneous triggers
  const p1 = coordinator.flush();
  const p2 = coordinator.flush();
  const p3 = coordinator.flush();

  await Promise.all([p1, p2, p3]);

  // Single-flight ensures only 1 save execution occurred for this generation
  assert.equal(callCount, 1);
  assert.equal(coordinator.isDirty(), false);
  coordinator.dispose();
});

test("LocalNoteAutosaveCoordinator — hydration & no user edits results in ZERO save calls", async () => {
  let saveCount = 0;
  const coordinator = new LocalNoteAutosaveCoordinator(
    "n1",
    { title: "Loaded Title", content: "Loaded Content", tags: ["t1"] },
    async () => {
      saveCount += 1;
    },
    50
  );

  // Hydrate baseline
  coordinator.resetBase({ title: "Loaded Title", content: "Loaded Content", tags: ["t1"] });

  // Wait longer than debounce
  await new Promise((r) => setTimeout(r, 100));

  assert.equal(saveCount, 0, "Hydration without user edit must produce 0 saves");
  assert.equal(coordinator.isDirty(), false);
  assert.equal(coordinator.getStatus(), "saved");
  coordinator.dispose();
});

test("LocalNoteAutosaveCoordinator — dispose/unmount does not cancel an in-flight required final drain", async () => {
  const saves: NoteSnapshot[] = [];
  let resolveSaveA: () => void = () => {};
  const coordinator = new LocalNoteAutosaveCoordinator(
    "n1",
    { title: "Init", content: "", tags: [] },
    async (snap) => {
      saves.push(snap);
      if (snap.title === "Edit A") {
        await new Promise<void>((resolve) => {
          resolveSaveA = resolve;
        });
      }
    },
    100
  );

  coordinator.updateSnapshot({ title: "Edit A", content: "Body A", tags: [] });
  const finalFlush = coordinator.flush();
  assert.equal(saves.length, 1, "save A started");

  // Unmount path: dispose() must NOT cancel the already-required final drain
  coordinator.dispose();
  resolveSaveA();

  const ok = await finalFlush;
  assert.equal(ok, true, "final drain completes despite dispose()");
  assert.equal(saves.length, 1);
  assert.equal(coordinator.isDirty(), false);
  assert.equal(coordinator.getStatus(), "saved");
});

test("LocalNoteAutosaveCoordinator — resetBase preserves single-flight while a drain is running", async () => {
  let callCount = 0;
  const saves: NoteSnapshot[] = [];
  let resolveSaveA: () => void = () => {};
  const coordinator = new LocalNoteAutosaveCoordinator(
    "n1",
    { title: "Init", content: "", tags: [] },
    async (snap) => {
      saves.push(snap);
      callCount += 1;
      if (snap.title === "Edit A") {
        await new Promise<void>((resolve) => {
          resolveSaveA = resolve;
        });
      }
    },
    100
  );

  coordinator.updateSnapshot({ title: "Edit A", content: "Body A", tags: [] });
  const flushA = coordinator.flush();
  assert.equal(saves.length, 1, "save A started");

  // Reload the same note while save A is still running (resetBase baseline).
  coordinator.resetBase({ title: "Reloaded", content: "Reloaded body", tags: [] });

  // A new final flush after resetBase joins the SAME drain (single-flight, no second save loop).
  const flushB = coordinator.flush();
  let flushBResolved = false;
  void flushB.then(() => {
    flushBResolved = true;
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(flushBResolved, false, "flush after resetBase joins the running drain");

  resolveSaveA();
  await Promise.all([flushA, flushB]);

  // Only ONE save loop ran (save A). resetBase must not have started a competing drain.
  assert.equal(callCount, 1, "single-flight preserved across resetBase");
  assert.equal(saves.length, 1);
  assert.equal(coordinator.isDirty(), false, "reset base is clean");
  assert.equal(coordinator.getStatus(), "saved");
  coordinator.dispose();
});

test("LocalNoteAutosaveCoordinator — old pre-reset receipt cannot acknowledge a post-reset edit", async () => {
  const saves: NoteSnapshot[] = [];
  let releaseFirst!: () => void;
  const coordinator = new LocalNoteAutosaveCoordinator("n1", {title: "Base", content: "", tags: []}, async snapshot => {
    saves.push(snapshot);
    if (saves.length === 1) await new Promise<void>(resolve => { releaseFirst = resolve; });
  }, 1000);
  coordinator.updateSnapshot({title: "Before reset", content: "A", tags: []});
  const drain = coordinator.flush();
  coordinator.resetBase({title: "Reloaded", content: "base", tags: []});
  coordinator.updateSnapshot({title: "After reset", content: "B", tags: []});
  const finalDrain = coordinator.flush();
  releaseFirst();
  await Promise.all([drain, finalDrain]);
  coordinator.dispose();
  assert.deepEqual(saves.map(snapshot => snapshot.content), ["A", "B"]);
  assert.equal(coordinator.isDirty(), false);
});
