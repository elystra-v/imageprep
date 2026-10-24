import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createBatch, MAX_BATCH_FILES, MAX_BATCH_INPUT_BYTES, MAX_BATCH_OUTPUT_BYTES,
} from '../src/batch.js';
import { MAX_FILE_BYTES } from '../src/core.js';

const MiB = 1024 * 1024;
const file = (name, size = 100) => Object.freeze({ name, size });
const result = (name = 'prepared.webp', size = 50) => ({
  name, width: 4, height: 3, blob: Object.freeze({ size }),
});
const tick = () => new Promise((resolve) => queueMicrotask(resolve));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('FIFO processing stays serial, coalesces starts, and preserves stable IDs and counters', async () => {
  const calls = [];
  const gates = [deferred(), deferred(), deferred()];
  let active = 0;
  let peak = 0;
  const batch = createBatch({ process: async (input) => {
    const index = calls.push(input.name) - 1;
    active += 1;
    peak = Math.max(peak, active);
    const output = await gates[index].promise;
    active -= 1;
    return output;
  } });
  const added = batch.add([file('a.png', 100), file('b.png', 200)]);
  const run = batch.start();
  assert.equal(batch.start(), run);
  await tick();
  assert.deepEqual(calls, ['a.png']);
  batch.add([file('c.png', 300)]);
  gates[0].resolve(result('a.webp', 10));
  await tick();
  await tick();
  assert.deepEqual(calls, ['a.png', 'b.png']);
  gates[1].resolve(result('b.webp', 20));
  await tick();
  await tick();
  assert.deepEqual(calls, ['a.png', 'b.png', 'c.png']);
  gates[2].resolve(result('c.webp', 30));
  const state = await run;
  assert.equal(peak, 1);
  assert.equal(state.running, false);
  assert.equal(state.inputBytes, 600);
  assert.equal(state.outputBytes, 60);
  assert.deepEqual(state.entries.map((entry) => entry.status), ['ready', 'ready', 'ready']);
  assert.deepEqual(state.entries.slice(0, 2).map((entry) => entry.id), added.accepted);
});

test('cancel discards the current result, retains ready outputs, and resumes only on explicit start', async () => {
  const gate = deferred();
  const calls = [];
  const batch = createBatch({ process: async (input) => {
    calls.push(input.name);
    return calls.length === 2 ? gate.promise : result(input.name);
  } });
  batch.add([file('a.png'), file('b.png'), file('c.png')]);
  const run = batch.start();
  await tick();
  await tick();
  assert.deepEqual(calls, ['a.png', 'b.png']);
  batch.cancel();
  assert.equal(batch.snapshot().running, true, 'cancel must retain the active decode lock');
  assert.deepEqual(batch.snapshot().entries.map((entry) => entry.status), ['ready', 'queued', 'queued']);
  assert.equal(batch.start(), run);
  gate.resolve(result('stale.webp', 999));
  const stopped = await run;
  assert.equal(stopped.running, false);
  assert.equal(stopped.outputBytes, 50);
  assert.deepEqual(calls, ['a.png', 'b.png']);
  await batch.start();
  assert.deepEqual(calls, ['a.png', 'b.png', 'b.png', 'c.png']);
  assert.equal(batch.snapshot().outputBytes, 150);
});

test('clearing and adding new files during a decode cannot revive old output or auto-start new files', async () => {
  const gate = deferred();
  const calls = [];
  const batch = createBatch({ process: async (input) => {
    calls.push(input.name);
    return calls.length === 1 ? gate.promise : result(input.name);
  } });
  const oldId = batch.add([file('old.png')]).accepted[0];
  const run = batch.start();
  await tick();
  batch.clear();
  const newId = batch.add([file('new.png')]).accepted[0];
  assert.notEqual(newId, oldId);
  assert.equal(batch.start(), run);
  gate.resolve(result('stale.webp'));
  await run;
  assert.deepEqual(calls, ['old.png']);
  assert.equal(batch.snapshot().entries[0].status, 'queued');
  assert.equal(batch.snapshot().outputBytes, 0);
  await batch.start();
  assert.deepEqual(calls, ['old.png', 'new.png']);
});

test('removing an active file drops its result but allows remaining queue to finish', async () => {
  const gate = deferred();
  let count = 0;
  const batch = createBatch({ process: async () => ++count === 1 ? gate.promise : result() });
  const ids = batch.add([file('a.png'), file('b.png')]).accepted;
  const run = batch.start();
  await tick();
  assert.equal(batch.remove(ids[0]), true);
  assert.equal(batch.remove(ids[0]), false);
  gate.reject(new Error('Old decoder failed'));
  await run;
  assert.equal(count, 2);
  assert.deepEqual(batch.snapshot().entries.map((entry) => [entry.id, entry.status]), [[ids[1], 'ready']]);
  assert.equal(batch.snapshot().inputBytes, 100);
  assert.equal(batch.snapshot().outputBytes, 50);
  batch.remove(ids[1]);
  assert.equal(batch.snapshot().outputBytes, 0);
});

test('settings changes invalidate ready and in-flight results and require explicit restart', async () => {
  const gate = deferred();
  const seen = [];
  const settings = { format: 'webp', quality: 0.8, dimensions: { width: 1200 } };
  const batch = createBatch({ settings, process: async (input, usedSettings) => {
    seen.push({ name: input.name, settings: usedSettings });
    return seen.length === 2 ? gate.promise : result();
  } });
  settings.dimensions.width = 10;
  batch.add([file('a.png'), file('b.png')]);
  const run = batch.start();
  await tick();
  await tick();
  assert.equal(batch.snapshot().entries[0].status, 'ready');
  batch.setSettings({ format: 'png', quality: 0.9, dimensions: { width: 600 } });
  assert.equal(batch.snapshot().outputBytes, 0);
  assert.deepEqual(batch.snapshot().entries.map((entry) => entry.status), ['queued', 'queued']);
  gate.resolve(result('old-format.webp'));
  await run;
  assert.equal(seen.length, 2);
  assert.equal(seen[0].settings.dimensions.width, 1200);
  await batch.start();
  assert.equal(seen.length, 4);
  assert.equal(seen[2].settings.format, 'png');
  assert.equal(seen[2].settings.dimensions.width, 600);
});

test('a damaged image and invalid result do not prevent valid files completing', async () => {
  const batch = createBatch({ process: async (input) => {
    if (input.name === 'broken.png') throw new Error('Invalid PNG image. A chunk checksum does not match.');
    if (input.name === 'empty.png') return { blob: { size: 0 } };
    return result(input.name);
  } });
  batch.add([file('broken.png'), file('valid.png'), file('empty.png'), file('also-valid.jpg')]);
  await batch.start();
  const state = batch.snapshot();
  assert.deepEqual(state.entries.map((entry) => entry.status), ['error', 'ready', 'error', 'ready']);
  assert.match(state.entries[0].error, /checksum/);
  assert.match(state.entries[2].error, /valid output/);
  assert.equal(state.outputBytes, 100);
  batch.setSettings({ format: 'png' });
  assert.ok(batch.snapshot().entries.every((entry) => entry.status === 'queued' && entry.error === null));
});

test('admission caps count and per-file size without removing earlier valid entries', () => {
  assert.equal(MAX_BATCH_FILES, 20);
  const batch = createBatch({ process: async () => result() });
  const oversized = file('huge.png', MAX_FILE_BYTES + 1);
  const empty = file('empty.png', 0);
  const first = batch.add([oversized, empty, file('valid.png')]);
  assert.equal(first.accepted.length, 1);
  assert.equal(first.rejected.length, 2);
  assert.equal(first.rejected[0].file, oversized);
  assert.match(first.rejected[0].error, /20 MiB/);
  const rest = batch.add(Array.from({ length: 21 }, (_, index) => file(`${index}.png`)));
  assert.equal(rest.accepted.length, 19);
  assert.equal(rest.rejected.length, 2);
  assert.match(rest.rejected[0].error, /20 images/);
  assert.equal(batch.snapshot().entries[0].id, first.accepted[0]);
});

test('combined input limit accepts the exact boundary and releases room after removal', () => {
  assert.equal(MAX_BATCH_INPUT_BYTES, 100 * MiB);
  const batch = createBatch({ process: async () => result() });
  const full = batch.add(Array.from({ length: 5 }, (_, index) => file(`${index}.png`, 20 * MiB)));
  assert.equal(full.accepted.length, 5);
  assert.equal(batch.snapshot().inputBytes, MAX_BATCH_INPUT_BYTES);
  const excess = batch.add([file('too-many-bytes.png', 1)]);
  assert.equal(excess.accepted.length, 0);
  assert.match(excess.rejected[0].error, /100 MiB/);
  batch.remove(full.accepted[0]);
  assert.equal(batch.add([file('replacement.png', 20 * MiB)]).accepted.length, 1);
});

test('output cap rejects only excess results and continues to a smaller valid result', async () => {
  assert.equal(MAX_BATCH_OUTPUT_BYTES, 100 * MiB);
  const sizes = [90 * MiB, 11 * MiB, 10 * MiB];
  const batch = createBatch({ process: async (input) => result(input.name, sizes.shift()) });
  batch.add([file('a.png'), file('b.png'), file('c.png')]);
  await batch.start();
  const state = batch.snapshot();
  assert.deepEqual(state.entries.map((entry) => entry.status), ['ready', 'error', 'ready']);
  assert.equal(state.outputBytes, MAX_BATCH_OUTPUT_BYTES);
  assert.match(state.entries[1].error, /100 MiB/);
  assert.equal(state.entries[1].output, null);
});

test('retry after freeing output capacity retains settings and other completed images', async () => {
  const calls = [];
  const batch = createBatch({ settings: { quality: 0.82 }, process: async (input) => {
    calls.push(input.name);
    return result(input.name, input.name === 'large.png' ? 90 * MiB : 6 * MiB);
  } });
  const ids = batch.add([file('large.png'), file('keep.png'), file('retry.png')]).accepted;
  await batch.start();
  assert.deepEqual(batch.snapshot().entries.map((entry) => entry.status), ['ready', 'ready', 'error']);
  const keptOutput = batch.snapshot().entries[1].output;
  batch.remove(ids[0]);
  assert.equal(batch.retry(ids[2]), true);
  const retried = batch.snapshot().entries[1];
  assert.equal(retried.status, 'queued');
  assert.equal(retried.error, null);
  assert.equal(retried.output, null);
  assert.equal(batch.snapshot().entries[0].output, keptOutput);
  assert.equal(batch.snapshot().settings.quality, 0.82);
  assert.deepEqual(calls, ['large.png', 'keep.png', 'retry.png'], 'retry queues work without implicitly starting a run');
  await batch.start();
  assert.deepEqual(calls, ['large.png', 'keep.png', 'retry.png', 'retry.png']);
  assert.equal(batch.snapshot().outputBytes, 12 * MiB);
  assert.ok(batch.snapshot().entries.every((entry) => entry.status === 'ready'));
  assert.equal(batch.snapshot().entries[0].output, keptOutput);
});

test('retry accepts only existing error entries and not queued, processing or ready entries', async () => {
  const gate = deferred();
  const batch = createBatch({ process: async () => gate.promise });
  const [id] = batch.add([file('a.png')]).accepted;
  assert.equal(batch.retry('missing'), false);
  assert.equal(batch.retry(id), false);
  const run = batch.start();
  await tick();
  assert.equal(batch.snapshot().entries[0].status, 'processing');
  assert.equal(batch.retry(id), false);
  gate.resolve(result());
  await run;
  assert.equal(batch.retry(id), false);
  assert.equal(batch.snapshot().entries[0].status, 'ready');
});

test('retry cannot revive removed or cleared entries, or reset a settings-invalidated entry', async () => {
  const batch = createBatch({ process: async () => { throw new Error('Decode failed'); } });
  const ids = batch.add([file('removed.png'), file('changed.png'), file('cleared.png')]).accepted;
  await batch.start();
  batch.remove(ids[0]);
  assert.equal(batch.retry(ids[0]), false);
  batch.setSettings({ format: 'png' });
  assert.equal(batch.retry(ids[1]), false, 'settings already requeued this file');
  assert.equal(batch.snapshot().entries[0].status, 'queued');
  await batch.start();
  assert.equal(batch.snapshot().entries[0].status, 'error');
  batch.clear();
  assert.equal(batch.retry(ids[1]), false);
  assert.equal(batch.retry(ids[2]), false);
  assert.equal(batch.snapshot().entries.length, 0);
});

test('listeners cannot mutate snapshots or stop processing by throwing', async () => {
  const batch = createBatch({ process: async () => result(), settings: { width: 800 } });
  let updates = 0;
  batch.subscribe(() => { throw new Error('View failed'); });
  const unsubscribe = batch.subscribe((state) => {
    updates += 1;
    assert.ok(Object.isFrozen(state));
    assert.ok(Object.isFrozen(state.entries));
    assert.ok(Object.isFrozen(state.settings));
  });
  batch.add([file('a.png')]);
  const snapshot = batch.snapshot();
  assert.throws(() => { snapshot.entries[0].status = 'ready'; }, TypeError);
  assert.throws(() => { snapshot.settings.width = 2; }, TypeError);
  await batch.start();
  assert.equal(batch.snapshot().entries[0].status, 'ready');
  const previousUpdates = updates;
  unsubscribe();
  batch.clear();
  assert.equal(updates, previousUpdates);
});

test('reentrant start from a synchronous listener shares the existing lock', async () => {
  const gate = deferred();
  let calls = 0;
  let listenerRun;
  const batch = createBatch({ process: async () => { calls += 1; return gate.promise; } });
  batch.subscribe((state) => {
    if (state.running) listenerRun = batch.start();
  });
  batch.add([file('a.png')]);
  const run = batch.start();
  assert.equal(listenerRun, run);
  await tick();
  assert.equal(calls, 1);
  gate.resolve(result());
  await run;
});

test('synchronous listener cancellation prevents a decoder from starting', async () => {
  let calls = 0;
  const batch = createBatch({ process: async () => { calls += 1; return result(); } });
  batch.subscribe((state) => {
    if (state.entries.some((entry) => entry.status === 'processing')) batch.cancel();
  });
  batch.add([file('a.png')]);
  await batch.start();
  assert.equal(calls, 0);
  assert.equal(batch.snapshot().entries[0].status, 'queued');
  assert.equal(batch.snapshot().running, false);
});

test('synchronous listener removal skips the removed decoder and continues safely', async () => {
  const calls = [];
  const batch = createBatch({ process: async (input) => { calls.push(input.name); return result(); } });
  batch.subscribe((state) => {
    const removed = state.entries.find((entry) => entry.file.name === 'a.png' && entry.status === 'processing');
    if (removed) batch.remove(removed.id);
  });
  batch.add([file('a.png'), file('b.png')]);
  await batch.start();
  assert.deepEqual(calls, ['b.png']);
  assert.equal(batch.snapshot().entries[0].status, 'ready');
});

test('invalid setup fails promptly, and idle controls do not create work', async () => {
  assert.throws(() => createBatch(), /processing must be a function/);
  const batch = createBatch({ process: async () => { throw new Error('Should not run'); } });
  assert.throws(() => batch.subscribe(null), /listener must be a function/);
  batch.cancel();
  batch.clear();
  assert.equal(batch.remove('missing'), false);
  assert.equal((await batch.start()).running, false);
  assert.equal(batch.snapshot().inputBytes, 0);
});
