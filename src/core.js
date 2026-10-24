export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_PIXELS = 24_000_000;
export const MAX_SIDE = 12_000;

const TYPES = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function invalid(format, detail = 'The file is damaged or incomplete.') {
  throw new Error(`Invalid ${format} image. ${detail}`);
}

function ascii(bytes, start, length) {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

export function validateDimensions(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new Error('Image dimensions must be positive whole numbers.');
  }
  if (width > MAX_SIDE || height > MAX_SIDE) {
    throw new Error('Image exceeds the 12,000 px side limit. Choose a smaller image.');
  }
  if (width * height > MAX_PIXELS) {
    throw new Error('Image exceeds the 24 million pixel limit. Choose a smaller image.');
  }
  return { width, height };
}

function checkedResult(type, width, height) {
  return { type, ...validateDimensions(width, height) };
}

function crc32(bytes, start, end) {
  let crc = 0xffffffff;
  for (let index = start; index < end; index += 1) {
    crc = CRC_TABLE[(crc ^ bytes[index]) & 255] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function inspectPng(bytes, view) {
  let offset = 8;
  let dimensions;
  let hasImageData = false;
  let endedImageData = false;
  let hasPalette = false;
  let colorType;
  while (offset < bytes.length) {
    if (bytes.length - offset < 12) invalid('PNG');
    const length = view.getUint32(offset);
    const name = ascii(bytes, offset + 4, 4);
    const data = offset + 8;
    // Subtraction avoids trusting an overflowing or truncated chunk length.
    if (length > bytes.length - data - 4) invalid('PNG');
    const end = data + length;
    if (!/^[A-Za-z]{4}$/.test(name)) invalid('PNG', 'The chunk header is damaged.');
    if (crc32(bytes, offset + 4, end) !== view.getUint32(end)) {
      invalid('PNG', 'A chunk checksum does not match.');
    }
    if (name === 'acTL' || name === 'fcTL' || name === 'fdAT') {
      throw new Error('Animated PNG images are not supported. Choose a still image.');
    }
    if (!dimensions && name !== 'IHDR') invalid('PNG', 'The image header must come first.');
    if (name === 'IHDR') {
      if (dimensions || offset !== 8 || length !== 13) invalid('PNG', 'The image header is damaged.');
      const width = view.getUint32(data);
      const height = view.getUint32(data + 4);
      const depth = bytes[data + 8];
      colorType = bytes[data + 9];
      const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!depths[colorType]?.includes(depth) || bytes[data + 10] !== 0 || bytes[data + 11] !== 0 || bytes[data + 12] > 1) {
        invalid('PNG', 'The image header uses unsupported or damaged settings.');
      }
      dimensions = checkedResult(TYPES.png, width, height);
    } else if (name === 'PLTE') {
      if (hasPalette || hasImageData || length === 0 || length > 768 || length % 3 !== 0 || colorType === 0 || colorType === 4) {
        invalid('PNG', 'The palette header is damaged.');
      }
      hasPalette = true;
    } else if (name === 'IDAT') {
      if (endedImageData || (colorType === 3 && !hasPalette)) invalid('PNG', 'The image data is out of order.');
      hasImageData = true;
    } else if (name === 'IEND') {
      if (length !== 0 || !hasImageData || end + 4 !== bytes.length) invalid('PNG');
      return dimensions;
    } else {
      if (hasImageData) endedImageData = true;
      if (name[0] === name[0].toUpperCase()) invalid('PNG', 'This PNG uses an unsupported critical chunk.');
    }
    offset = end + 4;
  }
  invalid('PNG', 'The image end marker is missing.');
}

function inspectJpeg(bytes, view) {
  let offset = 2;
  let dimensions;
  let componentIds;
  let inScan = false;
  let hasScan = false;
  let hasScanData = false;
  while (offset < bytes.length) {
    if (inScan) {
      // Entropy bytes use FF 00 escapes and restart markers. Other markers
      // return to the segment parser, including progressive JPEG scans.
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) {
          hasScanData = true;
          offset += 1;
          continue;
        }
        const markerStart = offset;
        while (bytes[offset] === 0xff) offset += 1;
        if (offset >= bytes.length) invalid('JPEG');
        const marker = bytes[offset];
        if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) {
          hasScanData = true;
          offset += 1;
          continue;
        }
        offset = markerStart;
        inScan = false;
        break;
      }
    }
    if (offset >= bytes.length || bytes[offset] !== 0xff) invalid('JPEG');
    while (bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) invalid('JPEG');
    const marker = bytes[offset++];
    if (marker === 0xd9) {
      if (!dimensions || !hasScan || !hasScanData) invalid('JPEG');
      return dimensions;
    }
    if (marker === 0x00 || marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      invalid('JPEG', 'The marker sequence is damaged.');
    }
    if (bytes.length - offset < 2) invalid('JPEG');
    const length = view.getUint16(offset);
    if (length < 2 || length > bytes.length - offset) invalid('JPEG');
    const data = offset + 2;
    const end = offset + length;
    const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isFrame) {
      if (![0xc0, 0xc1, 0xc2].includes(marker)) {
        invalid('JPEG', 'Only standard baseline and progressive JPEG images are supported.');
      }
      if (dimensions || length < 8) invalid('JPEG', 'The frame header is damaged.');
      const components = bytes[data + 5];
      if (bytes[data] !== 8 || ![1, 3, 4].includes(components) || length !== 8 + 3 * components) {
        invalid('JPEG', 'The frame header uses unsupported or damaged settings.');
      }
      dimensions = checkedResult(TYPES.jpeg, view.getUint16(data + 3), view.getUint16(data + 1));
      componentIds = new Set();
      for (let index = 0; index < components; index += 1) {
        const entry = data + 6 + index * 3;
        const id = bytes[entry];
        const horizontal = bytes[entry + 1] >>> 4;
        const vertical = bytes[entry + 1] & 15;
        if (componentIds.has(id) || horizontal < 1 || horizontal > 4 || vertical < 1 || vertical > 4 || bytes[entry + 2] > 3) {
          invalid('JPEG', 'The frame component header is damaged.');
        }
        componentIds.add(id);
      }
    } else if (marker === 0xda) {
      if (!dimensions || length < 6) invalid('JPEG', 'The scan header is damaged.');
      const components = bytes[data];
      if (components < 1 || components > componentIds.size || length !== 6 + 2 * components) invalid('JPEG');
      const scanIds = new Set();
      for (let index = 0; index < components; index += 1) {
        const entry = data + 1 + index * 2;
        const id = bytes[entry];
        const tables = bytes[entry + 1];
        if (!componentIds.has(id) || scanIds.has(id) || (tables >>> 4) > 3 || (tables & 15) > 3) invalid('JPEG');
        scanIds.add(id);
      }
      hasScan = true;
      inScan = true;
    }
    // APP/EXIF contents are deliberately opaque. Browser decoding handles
    // orientation later; this preflight bounds the raw frame's allocation.
    offset = end;
  }
  invalid('JPEG', 'The image end marker is missing.');
}

function uint24(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function inspectWebp(bytes, view) {
  if (bytes.length < 12 || view.getUint32(4, true) !== bytes.length - 8 || ascii(bytes, 8, 4) !== 'WEBP') invalid('WebP');
  let offset = 12;
  let canvas;
  let dimensions;
  while (offset < bytes.length) {
    if (bytes.length - offset < 8) invalid('WebP');
    const name = ascii(bytes, offset, 4);
    const length = view.getUint32(offset + 4, true);
    const data = offset + 8;
    const paddedLength = length + (length % 2);
    if (paddedLength > bytes.length - data) invalid('WebP');
    if (name === 'ANIM' || name === 'ANMF') {
      throw new Error('Animated WebP images are not supported. Choose a still image.');
    }
    if (name === 'VP8X') {
      if (canvas || offset !== 12 || length !== 10) invalid('WebP', 'The extended header is damaged.');
      if (bytes[data] & 0x02) throw new Error('Animated WebP images are not supported. Choose a still image.');
      if ((bytes[data] & 0xc1) || bytes[data + 1] || bytes[data + 2] || bytes[data + 3]) invalid('WebP', 'The extended header is damaged.');
      canvas = checkedResult(TYPES.webp, uint24(bytes, data + 4) + 1, uint24(bytes, data + 7) + 1);
    } else if (name === 'VP8 ' || name === 'VP8L') {
      if (dimensions) invalid('WebP', 'More than one still image was found.');
      if (name === 'VP8 ') {
        if (length < 10 || (bytes[data] & 1) || bytes[data + 3] !== 0x9d || bytes[data + 4] !== 0x01 || bytes[data + 5] !== 0x2a) {
          invalid('WebP', 'The VP8 frame header is damaged.');
        }
        dimensions = checkedResult(TYPES.webp, view.getUint16(data + 6, true) & 0x3fff, view.getUint16(data + 8, true) & 0x3fff);
      } else {
        if (length < 5 || bytes[data] !== 0x2f) invalid('WebP', 'The lossless header is damaged.');
        const packed = view.getUint32(data + 1, true);
        if (packed >>> 29) invalid('WebP', 'The lossless header uses an unsupported version.');
        dimensions = checkedResult(TYPES.webp, (packed & 0x3fff) + 1, ((packed >>> 14) & 0x3fff) + 1);
      }
    }
    offset = data + paddedLength;
  }
  if (!dimensions) invalid('WebP', 'The image frame is missing.');
  if (canvas && (canvas.width !== dimensions.width || canvas.height !== dimensions.height)) {
    invalid('WebP', 'The canvas and frame dimensions do not match.');
  }
  return dimensions;
}

/** Validate container structure and allocation bounds, not compressed pixels.
 * A successful browser decode is still required before displaying/exporting.
 * Type is identified from bytes; callers must not trust a filename or File.type.
 */
export function inspectImage(buffer) {
  if (!(buffer instanceof ArrayBuffer)) throw new TypeError('Image data must be an ArrayBuffer.');
  if (buffer.byteLength > MAX_FILE_BYTES) throw new Error('Image exceeds the 20 MiB file limit. Choose a smaller image.');
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  if (bytes.length >= 8 && PNG_SIGNATURE.every((value, index) => bytes[index] === value)) return inspectPng(bytes, view);
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return inspectJpeg(bytes, view);
  if (bytes.length >= 4 && ascii(bytes, 0, 4) === 'RIFF') return inspectWebp(bytes, view);
  throw new Error('Unsupported image. Choose a still PNG, JPEG or WebP file.');
}

export function fitDimensions(width, height, maxEdge) {
  validateDimensions(width, height);
  if (!Number.isSafeInteger(maxEdge) || maxEdge < 1) throw new Error('Maximum edge must be a positive whole number.');
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export function outputName(filename, mime, width, height) {
  validateDimensions(width, height);
  const extension = mime === TYPES.png ? 'png' : mime === TYPES.jpeg ? 'jpg' : mime === TYPES.webp ? 'webp' : null;
  if (!extension) throw new Error('Choose PNG, JPEG or WebP as the output format.');
  const leaf = String(filename ?? '').split(/[\\/]/).pop();
  const stem = leaf.replace(/\.[^.]*$/, '').normalize('NFKC');
  const safe = stem.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 80) || 'image';
  return `${safe}-imageprep-${width}x${height}.${extension}`;
}

export function formatBytes(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Byte size must be a non-negative whole number.');
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length);
  return `${(bytes / 1024 ** power).toFixed(1)} ${units[power - 1]}`;
}
