import { MAX_FILE_BYTES } from './core.js';

export const MAX_BATCH_FILES = 20;
export const MAX_BATCH_INPUT_BYTES = 100 * 1024 * 1024;
export const MAX_BATCH_OUTPUT_BYTES = 100 * 1024 * 1024;

function freezeSettings(value) {
  const copy = structuredClone(value);
  function freeze(item) {
    if (item && typeof item === 'object') {
      for (const child of Object.values(item)) freeze(child);
      Object.freeze(item);
    }
    return item;
  }
  return freeze(copy);
}

/**
 * One bounded, serial image queue. Processing is injected so this module owns no
 * canvas, object URLs, browser decoding, or downloads. Cancellation is cooperative:
 * an existing decode finishes, but its result is rejected before entering state.
 */
export function createBatch({ process, settings = {} } = {}) {
  if (typeof process !== 'function') throw new TypeError('Image processing must be a function.');
  let entries = [];
  let currentSettings = freezeSettings(settings);
  let nextId = 1;
  let revision = 0;
  let activeRun = null;
  const listeners = new Set();
  let emitting = false;
  let emitPending = false;

  function snapshot() {
    return Object.freeze({
      entries: Object.freeze(entries.map((entry) => Object.freeze({ ...entry }))),
      running: activeRun !== null,
      settings: currentSettings,
      inputBytes: entries.reduce((bytes, entry) => bytes + entry.file.size, 0),
      outputBytes: entries.reduce((bytes, entry) => bytes + (entry.output?.blob.size ?? 0), 0),
    });
  }

  function callListener(listener, state) {
    // A failing view must not strand processing or prevent other views updating.
    try { listener(state); } catch { /* Listener errors belong to the consumer. */ }
  }

  function emit() {
    emitPending = true;
    if (emitting) return;
    emitting = true;
    try {
      while (emitPending) {
        emitPending = false;
        const state = snapshot();
        for (const listener of [...listeners]) {
          if (listeners.has(listener)) callListener(listener, state);
        }
      }
    } finally {
      emitting = false;
    }
  }

  function add(files) {
    const accepted = [];
    const rejected = [];
    let bytes = snapshot().inputBytes;
    for (const file of files) {
      let error = null;
      if (!file || typeof file.name !== 'string' || !Number.isSafeInteger(file.size) || file.size < 1) {
        error = 'Choose a non-empty image file.';
      } else if (file.size > MAX_FILE_BYTES) {
        error = 'This file exceeds the 20 MiB image limit. Choose a smaller image.';
      } else if (entries.length >= MAX_BATCH_FILES) {
        error = 'A batch can contain up to 20 images. Remove an image before adding another.';
      } else if (bytes + file.size > MAX_BATCH_INPUT_BYTES) {
        error = 'The batch would exceed 100 MiB of original images. Remove some images first.';
      }
      if (error) {
        rejected.push({ file, error });
        continue;
      }
      const id = `image-${nextId++}`;
      entries.push({ id, file, status: 'queued', output: null, error: null });
      bytes += file.size;
      accepted.push(id);
    }
    if (accepted.length) emit();
    return { accepted, rejected };
  }

  function stopRun() {
    revision += 1;
    for (const entry of entries) {
      if (entry.status === 'processing') entry.status = 'queued';
    }
  }

  function cancel() {
    if (!activeRun || activeRun.revision !== revision) return;
    stopRun();
    emit();
  }

  function setSettings(settings) {
    const nextSettings = freezeSettings(settings);
    stopRun();
    currentSettings = nextSettings;
    for (const entry of entries) {
      entry.status = 'queued';
      entry.output = null;
      entry.error = null;
    }
    emit();
  }

  function remove(id) {
    const index = entries.findIndex((entry) => entry.id === id);
    if (index < 0) return false;
    entries.splice(index, 1);
    emit();
    return true;
  }

  function retry(id) {
    const entry = entries.find((item) => item.id === id);
    if (!entry || entry.status !== 'error') return false;
    entry.status = 'queued';
    entry.output = null;
    entry.error = null;
    emit();
    return true;
  }

  function clear() {
    stopRun();
    entries = [];
    emit();
  }

  function isCurrent(run, entry) {
    return activeRun === run && run.revision === revision && entries.includes(entry);
  }

  async function drain(run) {
    try {
      while (activeRun === run && run.revision === revision) {
        const entry = entries.find((item) => item.status === 'queued');
        if (!entry) break;
        entry.status = 'processing';
        emit();
        // A synchronous listener may cancel, clear, or remove this entry.
        if (!isCurrent(run, entry)) continue;
        try {
          const output = await process(entry.file, run.settings);
          if (!isCurrent(run, entry)) continue;
          if (!output?.blob || !Number.isSafeInteger(output.blob.size) || output.blob.size < 1) {
            throw new Error('Image preparation did not produce a valid output. Try another image.');
          }
          if (snapshot().outputBytes + output.blob.size > MAX_BATCH_OUTPUT_BYTES) {
            throw new Error('Prepared images would exceed 100 MiB. Remove a completed image or choose a smaller output.');
          }
          entry.output = Object.freeze({ ...output });
          entry.status = 'ready';
          entry.error = null;
        } catch (error) {
          if (!isCurrent(run, entry)) continue;
          entry.status = 'error';
          entry.output = null;
          entry.error = error instanceof Error && error.message ? error.message : 'This image could not be prepared. Try another image.';
        }
        emit();
      }
    } finally {
      if (activeRun === run) activeRun = null;
      const finished = snapshot();
      emit();
      run.resolve(finished);
    }
  }

  function start() {
    // Retain this lock even after cancellation until the old decode has drained.
    if (activeRun) return activeRun.promise;
    if (!entries.some((entry) => entry.status === 'queued')) return Promise.resolve(snapshot());
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    const run = { revision, settings: currentSettings, promise, resolve };
    activeRun = run;
    emit();
    // Publish the lock before invoking views or user processing code. A start()
    // triggered synchronously by either cannot launch a second decode.
    queueMicrotask(() => { void drain(run); });
    return promise;
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('A batch listener must be a function.');
    listeners.add(listener);
    callListener(listener, snapshot());
    return () => { listeners.delete(listener); };
  }

  return Object.freeze({ add, setSettings, start, cancel, remove, retry, clear, subscribe, snapshot });
}
