import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { MAX_FILE_BYTES, MAX_PIXELS, MAX_SIDE, inspectImage, validateDimensions, fitDimensions, outputName, formatBytes } from '../src/core.js';

const arrayBuffer = (bytes) => Uint8Array.from(bytes).buffer;
const inspect = (bytes) => inspectImage(arrayBuffer(bytes));
const concat = (...parts) => Buffer.concat(parts.map((part) => Buffer.from(part)));

// Fixture construction is separate from the parser. PNG includes real compressed
// pixels; JPEG/WebP fixtures exercise container headers, not browser decoding.
function pngChunk(type, data) {
  const body = concat(Buffer.from(type), data);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length);
  body.copy(chunk, 4);
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  return chunk;
}

function png(width = 1, height = 1, extra = []) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return concat([137, 80, 78, 71, 13, 10, 26, 10], pngChunk('IHDR', header), ...extra,
    pngChunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 128]))), pngChunk('IEND', Buffer.alloc(0)));
}

function jpegSegment(marker, payload) {
  const header = Buffer.from([0xff, marker, 0, 0]);
  header.writeUInt16BE(payload.length + 2, 2);
  return concat(header, payload);
}

function jpeg(width = 4, height = 3, { metadata = [], frame = 0xc0, scanData = [0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56] } = {}) {
  const header = Buffer.from([8, 0, 0, 0, 0, 1, 1, 0x11, 0]);
  header.writeUInt16BE(height, 1);
  header.writeUInt16BE(width, 3);
  return concat([0xff, 0xd8], ...metadata, jpegSegment(frame, header), jpegSegment(0xda, [1, 1, 0, 0, 63, 0]), scanData, [0xff, 0xd9]);
}

function exifOrientation(orientation) {
  // A little-endian TIFF IFD with the orientation tag. The preflight must not
  // rotate dimensions or mistake FF marker-looking bytes inside APP metadata.
  return jpegSegment(0xe1, concat(Buffer.from('Exif\0\0'), [0x49, 0x49, 42, 0, 8, 0, 0, 0, 1, 0,
    0x12, 0x01, 3, 0, 1, 0, 0, 0, orientation, 0, 0, 0, 0, 0, 0, 0]));
}

function webpChunk(type, data) {
  const header = Buffer.alloc(8);
  header.write(type);
  header.writeUInt32LE(data.length, 4);
  return concat(header, data, data.length % 2 ? [0] : []);
}

function webp(...chunks) {
  const data = concat(Buffer.from('WEBP'), ...chunks);
  const header = Buffer.alloc(8);
  header.write('RIFF');
  header.writeUInt32LE(data.length, 4);
  return concat(header, data);
}

function vp8(width = 4, height = 3) {
  const data = Buffer.from([0x10, 0, 0, 0x9d, 1, 0x2a, 0, 0, 0, 0]);
  data.writeUInt16LE(width, 6);
  data.writeUInt16LE(height, 8);
  return webpChunk('VP8 ', data);
}

function vp8l(width = 4, height = 3, version = 0) {
  const data = Buffer.alloc(5);
  data[0] = 0x2f;
  data.writeUInt32LE(((width - 1) | ((height - 1) << 14) | (version << 29)) >>> 0, 1);
  return webpChunk('VP8L', data);
}

function vp8x(width = 4, height = 3, flags = 0) {
  const data = Buffer.alloc(10);
  data[0] = flags;
  data.writeUIntLE(width - 1, 4, 3);
  data.writeUIntLE(height - 1, 7, 3);
  return webpChunk('VP8X', data);
}

test('identifies bytes rather than a filename or declared MIME', () => {
  const mislabeledFile = { name: 'photo.jpg', type: 'image/jpeg', bytes: png() };
  assert.deepEqual(inspect(mislabeledFile.bytes), { type: 'image/png', width: 1, height: 1 });
  assert.deepEqual(inspect(jpeg()), { type: 'image/jpeg', width: 4, height: 3 });
  assert.deepEqual(inspect(webp(vp8())), { type: 'image/webp', width: 4, height: 3 });
  assert.deepEqual(inspect(webp(vp8l())), { type: 'image/webp', width: 4, height: 3 });
  assert.throws(() => inspect(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), /Unsupported image/);
  assert.throws(() => inspect(Buffer.from('GIF89a')), /Unsupported image/);
  assert.throws(() => inspect(new Uint8Array(0)), /Unsupported image/);
  assert.throws(() => inspectImage(new Uint8Array(20)), /ArrayBuffer/);
});

test('validates exact geometry limits and invalid numbers', () => {
  assert.equal(MAX_SIDE, 12000);
  assert.equal(MAX_PIXELS, 24000000);
  assert.deepEqual(validateDimensions(12000, 2000), { width: 12000, height: 2000 });
  assert.deepEqual(validateDimensions(6000, 4000), { width: 6000, height: 4000 });
  assert.throws(() => validateDimensions(12001, 1), /12,000 px/);
  assert.throws(() => validateDimensions(6000, 4001), /24 million/);
  for (const invalid of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => validateDimensions(invalid, 1), /positive whole/);
    assert.throws(() => validateDimensions(1, invalid), /positive whole/);
  }
});

test('bounds byte size before parsing, with exact-limit input still inspected', () => {
  assert.equal(MAX_FILE_BYTES, 20 * 1024 * 1024);
  assert.throws(() => inspectImage(new ArrayBuffer(MAX_FILE_BYTES + 1)), /20 MiB/);
  assert.throws(() => inspectImage(new ArrayBuffer(MAX_FILE_BYTES)), /Unsupported image/);
});

test('bounds PNG dimensions before browser decoding', () => {
  assert.equal(inspect(png(6000, 4000)).width, 6000);
  assert.throws(() => inspect(png(12001, 1)), /12,000 px/);
  assert.throws(() => inspect(png(6000, 4001)), /24 million/);
  assert.throws(() => inspect(png(0, 1)), /positive whole/);
});

test('rejects PNG truncation, corrupted CRC, oversized chunk offsets and malformed headers', () => {
  const valid = png();
  for (const cutoff of [8, 12, 20, 32, valid.length - 1, valid.length - 12]) {
    assert.throws(() => inspect(valid.subarray(0, cutoff)), /Invalid PNG/);
  }
  const damaged = Buffer.from(valid);
  damaged[20] ^= 1;
  assert.throws(() => inspect(damaged), /checksum/);
  const oversized = Buffer.from(valid);
  oversized.writeUInt32BE(0xffffffff, 8);
  assert.throws(() => inspect(oversized), /Invalid PNG/);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 3; header[9] = 6;
  const badDepth = concat(valid.subarray(0, 8), pngChunk('IHDR', header), valid.subarray(33));
  assert.throws(() => inspect(badDepth), /header/);
  assert.throws(() => inspect(concat(valid, [0])), /Invalid PNG/);
});

test('rejects APNG control and frame chunks even when their placement is unusual', () => {
  for (const type of ['acTL', 'fcTL', 'fdAT']) {
    assert.throws(() => inspect(png(1, 1, [pngChunk(type, Buffer.alloc(8))])), /Animated PNG/);
  }
});

test('JPEG EXIF metadata is skipped and raw dimensions remain unrotated', () => {
  const metadata = [exifOrientation(6), jpegSegment(0xe2, [0xff, 0xc0, 0xff, 0xd9, 0, 0])];
  assert.deepEqual(inspect(jpeg(4000, 3000, { metadata })), { type: 'image/jpeg', width: 4000, height: 3000 });
  assert.deepEqual(inspect(jpeg(4000, 3000, { metadata: [exifOrientation(8)], frame: 0xc2 })), { type: 'image/jpeg', width: 4000, height: 3000 });
});

test('JPEG handles progressive scans, escaped entropy and metadata between scans', () => {
  const first = jpeg(12, 8, { frame: 0xc2 });
  const secondScan = concat(jpegSegment(0xc4, [0, 0]), jpegSegment(0xda, [1, 1, 0, 1, 63, 0]), [0x34, 0xff, 0x00, 0x56]);
  assert.deepEqual(inspect(concat(first.subarray(0, -2), secondScan, [0xff, 0xd9])), { type: 'image/jpeg', width: 12, height: 8 });
});

test('rejects damaged JPEG lengths, missing markers, duplicate frames and allocation excess', () => {
  const valid = jpeg();
  for (const cutoff of [2, 3, 5, 10, valid.length - 1, valid.length - 2]) {
    assert.throws(() => inspect(valid.subarray(0, cutoff)), /Invalid JPEG/);
  }
  const badLength = Buffer.from(valid);
  badLength.writeUInt16BE(1, 4);
  assert.throws(() => inspect(badLength), /Invalid JPEG/);
  const hugeMetadata = concat([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff], [0]);
  assert.throws(() => inspect(hugeMetadata), /Invalid JPEG/);
  assert.throws(() => inspect(jpeg(4, 3, { scanData: [] })), /Invalid JPEG/);
  assert.throws(() => inspect(jpeg(4, 3, { frame: 0xc3 })), /baseline and progressive/);
  const duplicateFrame = concat(valid.subarray(0, 15), valid.subarray(2));
  assert.throws(() => inspect(duplicateFrame), /frame header/);
  assert.throws(() => inspect(jpeg(12001, 1)), /12,000 px/);
  assert.throws(() => inspect(jpeg(6000, 4001)), /24 million/);
});

test('accepts extended still WebP, alpha flags and correctly padded metadata', () => {
  assert.deepEqual(inspect(webp(vp8x(7, 5, 0x10), webpChunk('ALPH', [0]), vp8(7, 5))), { type: 'image/webp', width: 7, height: 5 });
  assert.deepEqual(inspect(webp(vp8x(7, 5, 0x08), vp8l(7, 5), webpChunk('EXIF', [1, 2, 3]))), { type: 'image/webp', width: 7, height: 5 });
});

test('rejects animated WebP flags and chunks', () => {
  assert.throws(() => inspect(webp(vp8x(4, 3, 0x02), vp8())), /Animated WebP/);
  for (const type of ['ANIM', 'ANMF']) {
    assert.throws(() => inspect(webp(vp8(), webpChunk(type, Buffer.alloc(0)))), /Animated WebP/);
  }
});

test('rejects inconsistent WebP canvas, malformed chunks, unsupported versions and size excess', () => {
  assert.throws(() => inspect(webp(vp8x(5, 3), vp8())), /dimensions do not match/);
  assert.throws(() => inspect(webp(vp8x())), /frame is missing/);
  assert.throws(() => inspect(webp(vp8(), vp8l())), /More than one/);
  assert.throws(() => inspect(webp(vp8l(4, 3, 1))), /unsupported version/);
  assert.throws(() => inspect(webp(vp8x(4, 3, 0x80), vp8())), /extended header/);
  const badRiff = webp(vp8()); badRiff.writeUInt32LE(0xffffffff, 4);
  assert.throws(() => inspect(badRiff), /Invalid WebP/);
  const badChunk = webp(vp8()); badChunk.writeUInt32LE(0xffffffff, 16);
  assert.throws(() => inspect(badChunk), /Invalid WebP/);
  const missingPadding = webp(vp8l()).subarray(0, -1); missingPadding.writeUInt32LE(missingPadding.length - 8, 4);
  assert.throws(() => inspect(missingPadding), /Invalid WebP/);
  const badSignature = webp(vp8()); badSignature[23] = 0;
  assert.throws(() => inspect(badSignature), /frame header/);
  assert.throws(() => inspect(webp(vp8(12001, 1))), /12,000 px/);
  assert.throws(() => inspect(webp(vp8l(6000, 4001))), /24 million/);
  assert.throws(() => inspect(webp(vp8x(16777216, 1), vp8())), /12,000 px/);
});

test('truncated input never produces an out-of-bounds RangeError', () => {
  for (const fixture of [png(), jpeg(), webp(vp8()), webp(vp8l()), webp(vp8x(), vp8())]) {
    for (let end = 0; end < fixture.length; end += 1) {
      assert.throws(() => inspect(fixture.subarray(0, end)), (error) => error instanceof Error && !(error instanceof RangeError));
    }
  }
});

test('fitDimensions preserves geometry within pixel rounding and never upscales', () => {
  assert.deepEqual(fitDimensions(4032, 3024, 1600), { width: 1600, height: 1200 });
  assert.deepEqual(fitDimensions(3024, 4032, 1600), { width: 1200, height: 1600 });
  assert.deepEqual(fitDimensions(320, 240, 1600), { width: 320, height: 240 });
  assert.deepEqual(fitDimensions(1, 12000, 100), { width: 1, height: 100 });
  assert.deepEqual(fitDimensions(12000, 1, 1), { width: 1, height: 1 });
  assert.deepEqual(fitDimensions(9, 4, 5), { width: 5, height: 2 });
  for (const maxEdge of [0, -1, 2.5, NaN, Infinity]) assert.throws(() => fitDimensions(10, 10, maxEdge), /Maximum edge/);
});

test('output filenames are new, bounded leaf names with extension matching selected MIME', () => {
  assert.equal(outputName('portrait.jpeg', 'image/png', 800, 600), 'portrait-imageprep-800x600.png');
  assert.equal(outputName('source.png', 'image/jpeg', 800, 600), 'source-imageprep-800x600.jpg');
  assert.equal(outputName('C:\\private\\photos\\family.webp', 'image/webp', 4, 3), 'family-imageprep-4x3.webp');
  assert.equal(outputName('../../photo.jpg', 'image/png', 4, 3), 'photo-imageprep-4x3.png');
  assert.equal(outputName('.png', 'image/png', 1, 1), 'image-imageprep-1x1.png');
  assert.equal(outputName('✨.png', 'image/png', 1, 1), 'image-imageprep-1x1.png');
  for (const name of ['<script>alert(1)</script>.png', '\u202eevil.png', 'CON.jpg', 'a'.repeat(300) + '.png', 'a\0\r\n.png']) {
    const result = outputName(name, 'image/webp', 4, 3);
    assert.match(result, /^[A-Za-z0-9_-]+-imageprep-4x3\.webp$/);
    assert.ok(result.length <= 103);
    assert.notEqual(result, name);
  }
  assert.throws(() => outputName('a.png', 'image/svg+xml', 1, 1), /output format/);
  assert.throws(() => outputName('a.png', '__proto__', 1, 1), /output format/);
});

test('formats binary byte units consistently and rejects invalid sizes', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1024), '1.0 KiB');
  assert.equal(formatBytes(1536), '1.5 KiB');
  assert.equal(formatBytes(MAX_FILE_BYTES), '20.0 MiB');
  for (const invalid of [-1, 1.5, Infinity, NaN]) assert.throws(() => formatBytes(invalid), /Byte size/);
});
