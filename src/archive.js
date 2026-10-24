// Images are already compressed. Store their bytes directly in the archive,
// keeping memory bounded to one small checksum buffer plus the output Blobs.
export const MAX_ZIP_FILES = 20;
export const MAX_ZIP_BYTES = 100 * 1024 * 1024;

const MAX_NAME_LENGTH = 120;
const CHECKSUM_CHUNK_BYTES = 1024 * 1024;
const encoder = new TextEncoder();
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return value >>> 0;
});

function checkCount(items) {
  if (!Array.isArray(items)) throw new TypeError('ZIP files must be an array.');
  if (items.length > MAX_ZIP_FILES) throw new RangeError('ZIP supports at most 20 files.');
}

function splitName(name) {
  const extension = name.match(/\.([A-Za-z0-9]{1,16})$/)?.[0] ?? '';
  return { stem: extension ? name.slice(0, -extension.length) : name, extension };
}

function safeName(name) {
  if (typeof name !== 'string') throw new TypeError('Each ZIP file needs a name.');
  const basename = name.split(/[\\/]/).at(-1);
  const { stem: originalStem, extension } = splitName(basename);
  let stem = originalStem.normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[._-]+|[._-]+$/g, '') || 'image';
  // These names are devices on Windows, including when they have an extension.
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem)) stem = `image-${stem}`;
  stem = stem.slice(0, MAX_NAME_LENGTH - extension.length).replace(/[._-]+$/g, '') || 'image';
  return `${stem}${extension}`;
}

/** Plan the same flat, portable names for individual and ZIP downloads. */
export function planNames(names) {
  checkCount(names);
  const sanitized = Array.from(names, safeName);
  const reserved = new Set(sanitized.map((name) => name.toLowerCase()));
  const used = new Set();
  return sanitized.map((name) => {
    let candidate = name;
    if (used.has(candidate.toLowerCase())) {
      const { stem, extension } = splitName(name);
      for (let number = 2; ; number += 1) {
        const suffix = `-${number}`;
        candidate = `${stem.slice(0, MAX_NAME_LENGTH - extension.length - suffix.length)}${suffix}${extension}`;
        if (!used.has(candidate.toLowerCase()) && !reserved.has(candidate.toLowerCase())) break;
      }
    }
    used.add(candidate.toLowerCase());
    return candidate;
  });
}

async function checksum(blob, size) {
  let crc = 0xffffffff;
  for (let offset = 0; offset < size; offset += CHECKSUM_CHUNK_BYTES) {
    const end = Math.min(size, offset + CHECKSUM_CHUNK_BYTES);
    const bytes = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
    if (bytes.byteLength !== end - offset) throw new Error('Could not read the complete image for ZIP.');
    for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function localHeader(entry, crc) {
  const bytes = new Uint8Array(30 + entry.nameBytes.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  // ASCII names, no data descriptor, and method 0 (stored).
  // A fixed 1980-01-01 date avoids embedding local timestamps.
  view.setUint16(12, 0x21, true);
  view.setUint32(14, crc, true);
  view.setUint32(18, entry.size, true);
  view.setUint32(22, entry.size, true);
  view.setUint16(26, entry.nameBytes.length, true);
  bytes.set(entry.nameBytes, 30);
  return bytes;
}

function directoryHeader(entry, crc, offset) {
  const bytes = new Uint8Array(46 + entry.nameBytes.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 20, true);
  view.setUint16(14, 0x21, true);
  view.setUint32(16, crc, true);
  view.setUint32(20, entry.size, true);
  view.setUint32(24, entry.size, true);
  view.setUint16(28, entry.nameBytes.length, true);
  view.setUint32(42, offset, true);
  bytes.set(entry.nameBytes, 46);
  return bytes;
}

/** Create a deterministic ZIP with 1–20 { name, blob } entries, up to 100 MiB. */
export async function createZip(items) {
  checkCount(items);
  if (!items.length) throw new RangeError('Choose at least one prepared image for ZIP.');
  const names = planNames(Array.from(items, (item) => item?.name));
  const entries = Array.from(items, (item, index) => {
    if (!(item?.blob instanceof Blob)) throw new TypeError('Each ZIP file needs a Blob.');
    const size = item.blob.size;
    if (!Number.isSafeInteger(size) || size < 0) throw new RangeError('Invalid image size for ZIP.');
    return { blob: item.blob, size, nameBytes: encoder.encode(names[index]) };
  });
  // Validate every entry before reading any image. Include both header copies,
  // names and the end record in the limit, rather than just the image payloads.
  const totalBytes = entries.reduce((total, entry) => total + entry.size + 76 + 2 * entry.nameBytes.length, 22);
  if (totalBytes > MAX_ZIP_BYTES) throw new RangeError('ZIP download must be 100 MiB or smaller.');

  const contents = [];
  const directory = [];
  let offset = 0;
  let directoryBytes = 0;
  for (const entry of entries) {
    const crc = await checksum(entry.blob, entry.size);
    const local = localHeader(entry, crc);
    const central = directoryHeader(entry, crc, offset);
    contents.push(local, entry.blob);
    directory.push(central);
    offset += local.byteLength + entry.size;
    directoryBytes += central.byteLength;
  }

  const end = new Uint8Array(22);
  const view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, entries.length, true);
  view.setUint16(10, entries.length, true);
  view.setUint32(12, directoryBytes, true);
  view.setUint32(16, offset, true);
  return new Blob([...contents, ...directory, end], { type: 'application/zip' });
}
