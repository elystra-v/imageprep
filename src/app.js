import { createBatch } from './batch.js';
import { prepareImage } from './processor.js';
import { createZip, planNames } from './archive.js';
import { formatBytes } from './core.js';

const $ = id => document.getElementById(id);
const ui = Object.fromEntries(['file','drop','clear','queue','empty','count','status','error','settings','fields','preset','size','format','format-help','quality','quality-value','quality-help','run','cancel','download-all','selected-name','original','original-meta','original-placeholder','result','result-meta','result-placeholder','savings','download','result-note','zoom'].map(id => [id, $(id)]));
let selectedId = null;
let previewOutput = null;
let originalURL = null;
let outputURL = null;
let zipURL = null;
let exporting = false;
let revision = 0;
let lastSnapshot;
let downloadTimer;
const settings = () => ({maxEdge: Number(ui.size.value), type: ui.format.value, quality: Number(ui.quality.value) / 100});
const batch = createBatch({process: prepareImage, settings: settings()});

function error(message = '') {ui.error.textContent = message; ui.error.hidden = !message;}
function setStatus(message) {ui.status.textContent = message;}
function syncFormat() {
  const png = ui.format.value === 'image/png';
  ui.quality.disabled = png;
  ui['quality-value'].textContent = png ? 'Lossless' : `${ui.quality.value}%`;
  ui['quality-help'].textContent = png ? 'PNG quality is not adjustable. The file may be larger.' : 'Higher quality usually makes a larger file.';
  ui['format-help'].textContent = ui.format.value === 'image/jpeg' ? 'JPEG fills transparent areas with white.' : 'Transparent areas are preserved.';
}
function revokeZip() {
  clearTimeout(downloadTimer);
  if (zipURL) URL.revokeObjectURL(zipURL);
  zipURL = null;
}
function releasePreview() {
  for (const key of ['original','result']) {ui[key].hidden = true; ui[key].removeAttribute('src');}
  if (originalURL) URL.revokeObjectURL(originalURL);
  if (outputURL) URL.revokeObjectURL(outputURL);
  originalURL = outputURL = null;
  previewOutput = null;
  ui.download.hidden = true;
  ui.download.removeAttribute('href');
  ui.download.removeAttribute('download');
  ui['original-placeholder'].hidden = false;
  ui['result-placeholder'].hidden = false;
  ui['original-meta'].textContent = '—';
  ui['result-meta'].textContent = '—';
  ui.savings.textContent = '';
  ui['result-note'].textContent = 'Select a prepared image to compare both versions.';
}
function renderPreview(snapshot, names) {
  const entry = snapshot.entries.find(item => item.id === selectedId);
  ui['selected-name'].textContent = entry?.file.name || 'Your image, before & after';
  if (!entry?.output) {
    releasePreview();
    ui['result-placeholder'].querySelector('span:not(.placeholder-icon)').textContent = entry?.status === 'error' ? 'This image could not be prepared' : entry?.status === 'processing' ? 'Preparing this image…' : 'Your prepared copy';
    ui['result-note'].textContent = entry?.error || 'Prepare your images, then select one to compare.';
    return;
  }
  const out = entry.output;
  if (previewOutput !== out) {
    releasePreview();
    previewOutput = out;
    originalURL = URL.createObjectURL(new Blob([entry.file], {type: out.sourceType}));
    outputURL = URL.createObjectURL(out.blob);
    ui.original.src = originalURL;
    ui.result.src = outputURL;
    ui.original.hidden = ui.result.hidden = false;
    ui['original-placeholder'].hidden = ui['result-placeholder'].hidden = true;
    ui['original-meta'].textContent = `${out.sourceWidth} × ${out.sourceHeight} · ${formatBytes(entry.file.size)}`;
    ui['result-meta'].textContent = `${out.width} × ${out.height} · ${formatBytes(out.blob.size)}`;
    const difference = entry.file.size - out.blob.size;
    const percent = (Math.abs(difference) / entry.file.size * 100).toFixed(1);
    ui.savings.textContent = difference > 0 ? `${percent}% smaller · ${formatBytes(difference)} saved` : difference < 0 ? `${percent}% larger · ${formatBytes(-difference)} more` : 'Same file size';
    ui['result-note'].textContent = difference < 0 ? 'Conversion can make an image larger. Compare another format, or keep the original.' : 'Check fine text, edges and colour before saving your copy.';
    ui.download.href = outputURL;
    ui.download.hidden = false;
  }
  ui.download.download = names.get(entry.id);
}
function render(snapshot) {
  lastSnapshot = snapshot;
  const ready = snapshot.entries.filter(item => item.status === 'ready');
  const pending = snapshot.entries.filter(item => item.status === 'queued');
  const failed = snapshot.entries.filter(item => item.status === 'error');
  const outputNames = planNames(ready.map(item => item.output.name));
  const names = new Map(ready.map((item, index) => [item.id, outputNames[index]]));
  if (!snapshot.entries.some(item => item.id === selectedId)) selectedId = snapshot.entries[0]?.id || null;
  const active = document.activeElement;
  const focusId = active?.dataset?.entry;
  const focusAction = active?.dataset?.action;
  ui.queue.replaceChildren();
  for (const entry of snapshot.entries) {
    const row = document.createElement('li');
    row.className = `queue-row${selectedId === entry.id ? ' selected' : ''}`;
    const select = document.createElement('button');
    select.type = 'button'; select.className = 'queue-select'; select.dataset.entry = entry.id; select.dataset.action = 'select';
    select.setAttribute('aria-pressed', String(selectedId === entry.id));
    const name = document.createElement('span'); name.className = 'queue-name'; name.textContent = entry.file.name;
    const meta = document.createElement('span'); meta.className = 'queue-meta';
    meta.textContent = entry.error || `${formatBytes(entry.file.size)}${entry.output ? ` → ${formatBytes(entry.output.blob.size)}` : ''}`;
    const state = document.createElement('span'); state.className = `queue-state ${entry.status}`;
    state.textContent = ({queued:'Waiting',processing:'Preparing…',ready:'Ready',error:'Needs attention'})[entry.status];
    select.append(name, meta, state);
    select.addEventListener('click', () => {selectedId = entry.id; render(lastSnapshot);});
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'queue-remove'; remove.dataset.entry = entry.id; remove.dataset.action = 'remove'; remove.textContent = '×';
    remove.setAttribute('aria-label', `Remove ${entry.file.name}`);
    remove.addEventListener('click', () => {batch.remove(entry.id); if (!document.activeElement?.dataset?.entry) ui.file.focus();});
    row.append(select);
    if (entry.status === 'error') {
      const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'queue-retry'; retry.textContent = 'Retry'; retry.dataset.entry = entry.id; retry.dataset.action = 'retry';
      retry.setAttribute('aria-label', `Retry ${entry.file.name}`);
      retry.addEventListener('click', () => {batch.retry(entry.id); ui.run.focus();});
      row.append(retry);
    }
    row.append(remove); ui.queue.append(row);
  }
  if (focusId) {
    const restore = [...ui.queue.querySelectorAll('button')].find(button => button.dataset.entry === focusId && button.dataset.action === focusAction);
    restore?.focus();
  }
  ui.empty.hidden = snapshot.entries.length > 0;
  ui.count.textContent = `${snapshot.entries.length} / 20`;
  ui.count.title = `${formatBytes(snapshot.inputBytes)} of input images`;
  ui.clear.disabled = snapshot.entries.length === 0;
  ui.fields.disabled = snapshot.running;
  ui.run.disabled = snapshot.running || exporting || pending.length === 0 || !ui.size.validity.valid;
  ui.run.textContent = snapshot.running ? 'Preparing…' : ready.length && pending.length ? 'Prepare remaining' : 'Prepare images';
  ui.cancel.disabled = !snapshot.running;
  ui['download-all'].disabled = snapshot.running || exporting || ready.length === 0;
  ui['download-all'].textContent = exporting ? 'Packaging…' : `Download ZIP${ready.length ? ` · ${ready.length}` : ''}`;
  if (snapshot.running) {
    const current = snapshot.entries.find(item => item.status === 'processing');
    setStatus(current ? `Preparing ${current.file.name}. ${ready.length} ready, ${pending.length} waiting.` : 'Finishing the current image before stopping…');
  } else if (snapshot.entries.length) {
    setStatus(`${ready.length} ready · ${pending.length} waiting${failed.length ? ` · ${failed.length} need attention` : ''}. ${ready.length ? 'Download individual copies or a ZIP of ready images.' : 'Choose settings, then prepare your images.'}`);
  } else setStatus('Your files stay on this device. Originals are never changed.');
  renderPreview(snapshot, names);
  syncFormat();
}
function addFiles(files) {
  if (!files.length) return;
  const result = batch.add(files);
  error(result.rejected.map(item => `${item.file.name}: ${item.error}`).join(' '));
  ui.file.value = '';
}
function updateSettings() {
  error(); syncFormat();
  batch.setSettings(settings());
}
ui.file.addEventListener('change', () => addFiles([...ui.file.files]));
ui.clear.addEventListener('click', () => {batch.clear(); selectedId = null; error(); ui.file.value = ''; ui.file.focus();});
ui.cancel.addEventListener('click', () => batch.cancel());
ui.settings.addEventListener('input', event => {
  if (event.target === ui.preset) return;
  if (event.target === ui.size) ui.preset.value = 'custom';
  updateSettings();
});
ui.preset.addEventListener('change', () => {
  const presets = {web1600: 1600, article1200: 1200, thumbnail480: 480};
  if (presets[ui.preset.value]) ui.size.value = String(presets[ui.preset.value]);
  updateSettings();
});
ui.settings.addEventListener('submit', event => {
  event.preventDefault();
  if (!ui.settings.reportValidity() || exporting) return;
  error();
  void batch.start();
});
ui.zoom.addEventListener('change', () => {
  for (const frame of document.querySelectorAll('.image-frame')) frame.classList.toggle('actual', ui.zoom.value === 'actual');
});
ui['download-all'].addEventListener('click', async () => {
  const ready = lastSnapshot.entries.filter(item => item.status === 'ready');
  if (!ready.length || lastSnapshot.running || exporting) return;
  exporting = true;
  revokeZip();
  render(lastSnapshot);
  const id = revision;
  error();
  try {
    const blob = await createZip(ready.map(item => ({name: item.output.name, blob: item.output.blob})));
    if (id !== revision) {setStatus('The queue changed. Download again when your selection is ready.'); return;}
    zipURL = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = zipURL; link.download = 'imageprep-copies.zip';
    document.body.append(link); link.click(); link.remove();
    downloadTimer = setTimeout(revokeZip, 60_000);
    setStatus(`ZIP ready with ${ready.length} prepared ${ready.length === 1 ? 'image' : 'images'}.`);
  } catch (reason) {error(reason.message || 'The ZIP could not be prepared. Download copies individually.');}
  finally {
    exporting = false;
    ui['download-all'].disabled = lastSnapshot.running || !lastSnapshot.entries.some(item => item.status === 'ready');
    ui['download-all'].textContent = `Download ZIP · ${lastSnapshot.entries.filter(item => item.status === 'ready').length}`;
    ui.run.disabled = lastSnapshot.running || !lastSnapshot.entries.some(item => item.status === 'queued') || !ui.size.validity.valid;
  }
});
for (const name of ['dragenter','dragover']) ui.drop.addEventListener(name, event => {event.preventDefault(); ui.drop.classList.add('dragover');});
ui.drop.addEventListener('dragleave', event => {if (!ui.drop.contains(event.relatedTarget)) ui.drop.classList.remove('dragover');});
ui.drop.addEventListener('drop', event => {event.preventDefault(); ui.drop.classList.remove('dragover'); addFiles([...event.dataTransfer.files]);});
window.addEventListener('dragover', event => {if (event.dataTransfer.types.includes('Files')) event.preventDefault();});
window.addEventListener('drop', event => {if (event.dataTransfer.types.includes('Files')) event.preventDefault();});
window.addEventListener('pagehide', () => {batch.clear(); releasePreview(); revokeZip();});
batch.subscribe(snapshot => {revision++; revokeZip(); render(snapshot);});
if (!('createImageBitmap' in window)) {ui.file.disabled = true; error('This browser does not support the image decoder. Use a current browser.');}
