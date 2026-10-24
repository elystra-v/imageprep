import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareImage } from '../src/processor.js';

// A complete small baseline JPEG container. Its byte header is inspected by the
// real parser; the platform decoder/canvas are injected to exercise ownership.
const jpegBytes = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 8, 0, 3, 0, 4, 1, 1, 0x11, 0,
  0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0, 0x12, 0xff, 0xd9,
]);
const settings = { maxEdge: 2, type: 'image/webp', quality: 0.82 };
const source = (bytes = jpegBytes) => ({
  name: 'test photo.jpg', type: 'application/octet-stream',
  size: bytes.byteLength,
  arrayBuffer: async () => bytes.slice().buffer,
});

function browser(t, options = {}) {
  const prior = new Map(['document', 'createImageBitmap'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const calls = { decode: [], draw: [], fill: [], encode: [], closed: 0, canvases: 0 };
  const bitmap = { width: options.width ?? 4, height: options.height ?? 3, close() { calls.closed += 1; } };
  const context = {
    fillRect(...args) { calls.fill.push({ args, colour: this.fillStyle }); },
    drawImage(...args) {
      calls.draw.push(args);
      if (options.drawError) throw options.drawError;
    },
  };
  const canvas = {
    width: 0, height: 0,
    getContext(kind) { assert.equal(kind, '2d'); return options.noContext ? null : context; },
    toBlob(callback, type, quality) {
      calls.encode.push({ type, quality, width: this.width, height: this.height });
      if (options.encodeError) throw options.encodeError;
      callback(options.nullOutput ? null : new Blob(['compressed pixels'], { type: options.actualType ?? type }));
    },
  };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement(name) { assert.equal(name, 'canvas'); calls.canvases += 1; return canvas; },
  } });
  Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, value: async (...args) => {
    calls.decode.push(args);
    if (options.decodeError) throw options.decodeError;
    return bitmap;
  } });
  t.after(() => {
    for (const [key, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  return { calls, bitmap, canvas, context };
}

function assertReleased(env) {
  assert.equal(env.calls.closed, 1, 'the decoded bitmap is closed exactly once');
  assert.equal(env.canvas.width, 0, 'the canvas backing allocation is released');
  assert.equal(env.canvas.height, 0);
}

test('valid export uses inspected MIME, oriented decoded dimensions, bounded resize and releases allocations', async (t) => {
  const env = browser(t, { width: 3, height: 4 });
  const output = await prepareImage(source(), settings);
  assert.equal(env.calls.decode.length, 1);
  assert.equal(env.calls.decode[0][0].type, 'image/jpeg', 'declared file MIME is not trusted');
  assert.deepEqual(env.calls.decode[0][1], { imageOrientation: 'from-image' });
  assert.equal(output.sourceWidth, 3);
  assert.equal(output.sourceHeight, 4);
  assert.equal(output.sourceType, 'image/jpeg');
  assert.equal(output.width, 2);
  assert.equal(output.height, 2);
  assert.equal(output.name, 'test-photo-imageprep-2x2.webp');
  assert.equal(output.blob.type, 'image/webp');
  assert.deepEqual(env.calls.draw[0], [env.bitmap, 0, 0, 2, 2]);
  assert.deepEqual(env.calls.encode, [{ type: 'image/webp', quality: 0.82, width: 2, height: 2 }]);
  assert.equal(env.context.imageSmoothingEnabled, true);
  assert.equal(env.context.imageSmoothingQuality, 'high');
  assert.equal(env.calls.fill.length, 0);
  assertReleased(env);
});

test('JPEG export fills white first and does not enlarge a smaller source', async (t) => {
  const env = browser(t);
  const output = await prepareImage(source(), { ...settings, type: 'image/jpeg', maxEdge: 1600 });
  assert.deepEqual(env.calls.fill, [{ args: [0, 0, 4, 3], colour: '#ffffff' }]);
  assert.deepEqual([output.width, output.height], [4, 3]);
  assert.equal(output.blob.type, 'image/jpeg');
  assertReleased(env);
});

test('malformed input fails before any decoder or canvas allocation', async (t) => {
  const env = browser(t);
  await assert.rejects(prepareImage(source(Uint8Array.from([0, 1, 2, 3])), settings), /Unsupported image/);
  assert.equal(env.calls.decode.length, 0);
  assert.equal(env.calls.canvases, 0);
  assert.equal(env.calls.closed, 0);
});

test('invalid settings fail before reading the file', async (t) => {
  const env = browser(t);
  let reads = 0;
  const input = { ...source(), arrayBuffer: async () => { reads += 1; return jpegBytes.slice().buffer; } };
  for (const changed of [{ maxEdge: 0 }, { maxEdge: 12001 }, { type: 'image/svg+xml' }, { quality: NaN }, { quality: 0.09 }]) {
    await assert.rejects(prepareImage(input, { ...settings, ...changed }), /Choose/);
  }
  assert.equal(reads, 0);
  assert.equal(env.calls.decode.length, 0);
});

test('decoder failure does not allocate a canvas', async (t) => {
  const env = browser(t, { decodeError: new Error('Decoder rejected image') });
  await assert.rejects(prepareImage(source(), settings), /Decoder rejected/);
  assert.equal(env.calls.decode.length, 1);
  assert.equal(env.calls.canvases, 0);
  assert.equal(env.calls.closed, 0);
});

test('decoded dimension limits are checked again and bitmap is released', async (t) => {
  const env = browser(t, { width: 12001, height: 1 });
  await assert.rejects(prepareImage(source(), settings), /12,000 px/);
  assert.equal(env.calls.canvases, 0);
  assertReleased(env);
});

test('missing 2D context releases both bitmap and canvas', async (t) => {
  const env = browser(t, { noContext: true });
  await assert.rejects(prepareImage(source(), settings), /could not create an image canvas/);
  assert.equal(env.calls.encode.length, 0);
  assertReleased(env);
});

test('drawing failure releases both bitmap and canvas', async (t) => {
  const env = browser(t, { drawError: new Error('Canvas draw failed') });
  await assert.rejects(prepareImage(source(), settings), /Canvas draw failed/);
  assert.equal(env.calls.encode.length, 0);
  assertReleased(env);
});

test('null encoder result rejects without retaining image allocations', async (t) => {
  const env = browser(t, { nullOutput: true });
  await assert.rejects(prepareImage(source(), settings), /could not be encoded/);
  assertReleased(env);
});

test('synchronous encoder exception releases image allocations', async (t) => {
  const env = browser(t, { encodeError: new Error('Encoder allocation failed') });
  await assert.rejects(prepareImage(source(), settings), /Encoder allocation failed/);
  assertReleased(env);
});

test('browser MIME fallback is rejected instead of naming PNG bytes as WebP', async (t) => {
  const env = browser(t, { actualType: 'image/png' });
  await assert.rejects(prepareImage(source(), settings), /cannot export that format/);
  assertReleased(env);
});
