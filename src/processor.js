import { inspectImage, validateDimensions, fitDimensions, outputName } from './core.js';

// The batch controller calls this serially. No decoded bitmap or canvas survives
// a job; only compressed input/output blobs remain in the queue.
export async function prepareImage(file, settings) {
  const { maxEdge, type, quality } = settings;
  if (!Number.isSafeInteger(maxEdge) || maxEdge < 1 || maxEdge > 12000) throw new Error('Choose a longest edge from 1 to 12,000 pixels.');
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(type)) throw new Error('Choose PNG, JPEG or WebP output.');
  if (!Number.isFinite(quality) || quality < 0.1 || quality > 1) throw new Error('Choose a quality from 10% to 100%.');
  const bytes = await file.arrayBuffer();
  const info = inspectImage(bytes);
  let bitmap;
  let canvas;
  try {
    bitmap = await createImageBitmap(new Blob([bytes], {type: info.type}), {imageOrientation: 'from-image'});
    validateDimensions(bitmap.width, bitmap.height);
    const {width, height} = fitDimensions(bitmap.width, bitmap.height, maxEdge);
    canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Your browser could not create an image canvas.');
    if (type === 'image/jpeg') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('The image could not be encoded. Try a smaller size.')), type, quality));
    if (blob.type !== type) throw new Error('This browser cannot export that format. Try PNG or JPEG.');
    return {blob, width, height, name: outputName(file.name, type, width, height), sourceWidth: bitmap.width, sourceHeight: bitmap.height, sourceType: info.type};
  } finally {
    bitmap?.close();
    if (canvas) {canvas.width = 0; canvas.height = 0;}
  }
}
