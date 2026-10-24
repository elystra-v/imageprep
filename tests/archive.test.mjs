import test from 'node:test';
import assert from 'node:assert/strict';
import { createZip, planNames, MAX_ZIP_BYTES, MAX_ZIP_FILES } from '../src/archive.js';

// An independent bit-at-a-time checksum checks stored payloads against both
// headers; the writer uses a lookup table and slices Blob input into chunks.
function referenceCrc(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

async function readZip(blob) {
  assert.equal(blob.type, 'application/zip');
  const data = Buffer.from(await blob.arrayBuffer());
  const end = data.length - 22;
  assert.equal(data.readUInt32LE(end), 0x06054b50);
  assert.equal(data.readUInt16LE(end + 4), 0);
  assert.equal(data.readUInt16LE(end + 6), 0);
  assert.equal(data.readUInt16LE(end + 20), 0);
  const count = data.readUInt16LE(end + 10);
  assert.equal(data.readUInt16LE(end + 8), count);
  const directoryStart = data.readUInt32LE(end + 16);
  assert.equal(directoryStart + data.readUInt32LE(end + 12), end);
  const entries = [];
  let directoryOffset = directoryStart;
  let nextLocal = 0;
  for (let index = 0; index < count; index += 1) {
    assert.equal(data.readUInt32LE(directoryOffset), 0x02014b50);
    const flags = data.readUInt16LE(directoryOffset + 8);
    const method = data.readUInt16LE(directoryOffset + 10);
    const crc = data.readUInt32LE(directoryOffset + 16);
    const compressedSize = data.readUInt32LE(directoryOffset + 20);
    const size = data.readUInt32LE(directoryOffset + 24);
    const nameLength = data.readUInt16LE(directoryOffset + 28);
    const extraLength = data.readUInt16LE(directoryOffset + 30);
    const commentLength = data.readUInt16LE(directoryOffset + 32);
    const offset = data.readUInt32LE(directoryOffset + 42);
    const name = data.subarray(directoryOffset + 46, directoryOffset + 46 + nameLength).toString('ascii');
    assert.equal(offset, nextLocal, 'local entries have no gaps, descriptors or hidden metadata');
    assert.equal(data.readUInt32LE(offset), 0x04034b50);
    assert.equal(flags, 0);
    assert.equal(data.readUInt16LE(offset + 6), flags);
    assert.equal(method, 0);
    assert.equal(data.readUInt16LE(offset + 8), method);
    assert.equal(data.readUInt16LE(offset + 10), 0);
    assert.equal(data.readUInt16LE(offset + 12), 0x21);
    assert.equal(data.readUInt16LE(directoryOffset + 12), 0);
    assert.equal(data.readUInt16LE(directoryOffset + 14), 0x21);
    assert.equal(compressedSize, size);
    assert.equal(data.readUInt32LE(offset + 14), crc);
    assert.equal(data.readUInt32LE(offset + 18), size);
    assert.equal(data.readUInt32LE(offset + 22), size);
    assert.equal(data.readUInt16LE(offset + 26), nameLength);
    assert.equal(data.readUInt16LE(offset + 28), 0);
    assert.equal(data.subarray(offset + 30, offset + 30 + nameLength).toString('ascii'), name);
    assert.equal(extraLength, 0);
    assert.equal(commentLength, 0);
    assert.equal(data.readUInt16LE(directoryOffset + 34), 0);
    const payloadStart = offset + 30 + nameLength;
    const bytes = data.subarray(payloadStart, payloadStart + size);
    assert.equal(bytes.length, size);
    assert.equal(referenceCrc(bytes), crc);
    entries.push({ name, bytes, crc });
    nextLocal = payloadStart + size;
    directoryOffset += 46 + nameLength + extraLength + commentLength;
  }
  assert.equal(nextLocal, directoryStart);
  assert.equal(directoryOffset, end);
  return entries;
}

test('ZIP preserves separate binary payloads, CRCs and directory offsets', async () => {
  const binary = Uint8Array.from({ length: 513 }, (_, index) => index % 256);
  const entries = await readZip(await createZip([
    { name: 'known.webp', blob: new Blob(['123456789']) },
    { name: 'binary.png', blob: new Blob([binary]) },
    { name: 'empty.jpg', blob: new Blob([]) },
  ]));
  assert.deepEqual(entries.map(({ name }) => name), ['known.webp', 'binary.png', 'empty.jpg']);
  assert.equal(entries[0].crc, 0xcbf43926);
  assert.equal(entries[0].bytes.toString(), '123456789');
  assert.deepEqual(entries[1].bytes, Buffer.from(binary));
  assert.equal(entries[2].crc, 0);
  assert.equal(entries[2].bytes.length, 0);
});

test('filenames are flat, portable ASCII with unique case-insensitive names', () => {
  const names = planNames([
    '../../foo.webp', 'C:\\Users\\Photo\\FOO.webp', 'foo-2.webp',
    '/tmp/café shot.png', '.hidden.jpg', 'CON.png', 'aux',
    '🐈.webp', '...', 'bad\0:name<>|.jpeg', 'CON.extra.png',
  ]);
  assert.deepEqual(names, [
    'foo.webp', 'FOO-3.webp', 'foo-2.webp', 'cafe-shot.png', 'hidden.jpg',
    'image-CON.png', 'image-aux', 'image.webp', 'image', 'bad-name.jpeg', 'image-CON.extra.png',
  ]);
  assert.equal(new Set(names.map((name) => name.toLowerCase())).size, names.length);
  for (const name of names) {
    assert.match(name, /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
    assert.equal(name.includes('..'), false);
  }
});

test('long colliding names remain bounded without losing image extensions', () => {
  const original = `${'a'.repeat(500)}.webp`;
  const names = planNames([original, original, original.toUpperCase()]);
  assert.equal(new Set(names.map((name) => name.toLowerCase())).size, 3);
  assert.equal(names[0].length, 120);
  assert.equal(names[1].length, 120);
  assert.equal(names[2].length, 120);
  assert.ok(names[1].endsWith('-2.webp'));
  assert.ok(names[2].endsWith('-3.WEBP'));
});

test('ZIP uses the same filename plan as individual downloads and is reproducible', async () => {
  const items = ['../same.PNG', 'same.png', '猫.jpg'].map((name, index) => ({ name, blob: new Blob([String(index)]) }));
  const first = await createZip(items);
  const second = await createZip(items);
  assert.deepEqual(await first.arrayBuffer(), await second.arrayBuffer());
  assert.deepEqual((await readZip(first)).map(({ name }) => name), planNames(items.map(({ name }) => name)));
});

test('accepts exactly 20 entries and rejects too many or malformed entries', async () => {
  assert.equal(MAX_ZIP_FILES, 20);
  const items = Array.from({ length: 20 }, () => ({ name: 'photo.png', blob: new Blob(['x']) }));
  assert.equal((await readZip(await createZip(items))).length, 20);
  await assert.rejects(createZip([...items, items[0]]), /at most 20/);
  await assert.rejects(createZip([]), /at least one/);
  await assert.rejects(createZip(null), /array/);
  await assert.rejects(createZip([null]), /name/);
  await assert.rejects(createZip(Array(1)), /name/);
  await assert.rejects(createZip([{ name: 10, blob: new Blob() }]), /name/);
  await assert.rejects(createZip([{ name: 'photo.png', blob: new Uint8Array(1) }]), /Blob/);
  assert.throws(() => planNames([null]), /name/);
  assert.throws(() => planNames(Array(1)), /name/);
});

test('100 MiB cap includes all ZIP overhead and is checked before reading files', async () => {
  assert.equal(MAX_ZIP_BYTES, 100 * 1024 * 1024);
  let reads = 0;
  class SizeOnlyBlob extends Blob {
    constructor(size) { super(); this.reportedSize = size; }
    get size() { return this.reportedSize; }
    slice() { reads += 1; throw new Error('boundary accepted, reached read'); }
  }
  for (const size of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(createZip([{ name: 'a', blob: new SizeOnlyBlob(size) }]), /Invalid image size/);
  }
  // With one ASCII one-character name: 30 + 46 + 2 name bytes + 22 EOCD.
  await assert.rejects(createZip([{ name: 'a', blob: new SizeOnlyBlob(MAX_ZIP_BYTES - 99) }]), /100 MiB/);
  assert.equal(reads, 0);
  await assert.rejects(createZip([{ name: 'a', blob: new SizeOnlyBlob(MAX_ZIP_BYTES - 100) }]), /boundary accepted/);
  assert.equal(reads, 1);
  reads = 0;
  await assert.rejects(createZip([
    { name: 'a', blob: new SizeOnlyBlob(MAX_ZIP_BYTES / 2) },
    { name: 'b', blob: new SizeOnlyBlob(MAX_ZIP_BYTES / 2) },
  ]), /100 MiB/);
  assert.equal(reads, 0);
});

test('checksums use bounded slices across a chunk boundary and detect incomplete reads', async () => {
  const bytes = new Uint8Array(1024 * 1024 + 17).fill(0xa5);
  const sizes = [];
  class ObservedBlob extends Blob {
    slice(start, end) { sizes.push(end - start); return super.slice(start, end); }
  }
  const entries = await readZip(await createZip([{ name: 'large.webp', blob: new ObservedBlob([bytes]) }]));
  assert.deepEqual(entries[0].bytes, Buffer.from(bytes));
  assert.deepEqual(sizes, [1024 * 1024, 17]);
  class TruncatedBlob extends Blob {
    slice() { return new Blob(); }
  }
  await assert.rejects(createZip([{ name: 'bad.png', blob: new TruncatedBlob(['x']) }]), /complete image/);
});
