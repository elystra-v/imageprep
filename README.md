# ImagePrep

ImagePrep is a standalone, on-device image preparation workspace. Bring a batch of still images, resize and compare them, then download new copies. The originals are never written to.

Licensed under [MIT](LICENSE). No image uploads, accounts or runtime package dependencies.

Version **0.2.1** is a local browser application with its own source repository. It has no dependency on the Elystra-V website, Astro, a cloud service, or a native desktop wrapper. The small local server serves static files only; image data stays in the browser. The same boundary applies when hosted: the host delivers the app files, while selected images are decoded, resized and encoded on the device. Hosting may involve ordinary access logs; this app contains no analytics or image-upload endpoint.

## Run locally

Download the repository with GitHub's **Code → Download ZIP**, then extract it and open a terminal in the extracted directory. Alternatively, clone it:

```sh
git clone https://github.com/elystra-v/imageprep.git
cd imageprep
```

Python 3 is the only prerequisite for serving the app. Use a current browser with JavaScript enabled:

```sh
python3 scripts/build.py
python3 scripts/serve.py
```

Open `http://127.0.0.1:4331/`. Use `--port 4332` if that port is occupied. Stop the server with Ctrl+C. To share a build, copy the contents of `dist/` to a static host; publication and a public address are separate decisions. JavaScript modules require HTTP; do not open index.html through a file URL.

## What it is for

Prepare photographs for web pages, screenshots for articles and documentation, or a batch of lighter copies for sharing. Compare dimensions, file size and fine details before downloading. This is a resize-and-convert tool, not a photo editor: it does not retouch, sharpen, restore or upscale images. Smaller files are not guaranteed.

## Current workflow

1. Choose or drop up to 20 still PNG, JPEG or WebP images.
2. Pick a longest edge, format and quality. Presets are convenient size starting points, not platform-specific requirements.
3. Prepare the batch. Images run sequentially. Damaged images remain visible and do not stop the others.
4. Select a finished image to compare the original and output. Fit view shows the complete image. Actual size uses one image pixel per CSS pixel; screen scaling and browser zoom still apply.
5. Download one copy, or a ZIP containing ready copies. The ZIP count is explicit, and error/unfinished entries remain visible in the queue. Duplicate filenames receive collision-safe suffixes.

Stop queue retains finished outputs and waiting files in this tab. The active decode/encode finishes safely, but its result is discarded and the image returns to the queue. Prepare remaining restarts pending work. Retry puts an error entry back in the queue without discarding other results. Clear all or leaving/reloading the page releases the session; this version does not persist work.

Settings are frozen while processing. Changing a setting afterward invalidates all existing outputs and queues the originals for a fresh run, so results from different settings cannot be mixed silently.

## Bounds and output behaviour

- Up to 20 MiB per file, 24 million decoded pixels and 12,000 pixels per side.
- Up to 20 files and 100 MiB of input files per queue; 100 MiB of retained output blobs.
- At most one processing bitmap/canvas at a time, released on success and failure. Only the selected comparison loads preview images. These are allocation bounds, not a strict browser RAM cap.
- ZIP is uncompressed because its images are already compressed. Checksums read 1 MiB slices; the resulting archive is capped at 100 MiB including headers. A payload exactly at the output cap may need individual downloads or fewer files to fit the ZIP.
- No upscaling. Aspect ratios are preserved within integer-pixel rounding.
- Actual bytes determine image type. Container checks precede browser decoding. APNG and animated WebP are rejected.
- The browser applies JPEG EXIF orientation. PNG/WebP retain transparency; JPEG uses white. Encoders must produce the requested MIME type or the output is rejected.
- Exports do not copy embedded metadata. Colour/ICC fidelity is not guaranteed. Outputs can be larger than originals; the UI reports both sizes honestly. This tool produces web-use copies, not archival masters.
- No network image processing, uploads, accounts, analytics, image history, service worker or persistent browser storage. The page CSP disallows network connections. The preview server binds to loopback and serves only `dist/`.

## Source layout

| File | Responsibility |
| --- | --- |
| `src/core.js` | Byte/container preflight, dimensions and names |
| `src/processor.js` | Browser decode, canvas render and resource cleanup |
| `src/batch.js` | Bounded serial queue, cancellation, retries and stale-result rejection |
| `src/archive.js` | Stored ZIP records, checksums and unique flat filenames |
| `src/app.js` | Workspace UI, selected comparison and downloads |
| `index.html`, `src/style.css` | Independent product interface |

There are no runtime package dependencies or installation scripts. With Node.js 22+ available, run:

```sh
node --test --test-concurrency=1 tests/*.test.mjs
```

The first standalone pass has 51 automated cases across the core, batch lifecycle, processor cleanup and ZIP format. Browser review on the Acer covers mixed valid/corrupt batches, duplicate names, retry, preset invalidation, actual-size layout and decoded WebP/JPEG ZIP outputs including EXIF orientation, alpha and white JPEG backgrounds. Source fixture hashes are unchanged. Tests and downloaded artifacts are recorded locally under ignored `review/`; private user images are never committed. Native OS drag-and-drop, other browsers and screen-reader behaviour have not been fully audited.

## Relationship to Elystra-V

ImagePrep began as a small single-image demo on the Elystra-V website. This repository is now the source of truth for the independent tool. The website introduces it at `/tools/imageprep/` and imports a versioned, byte-identical runtime at `/apps/imageprep/`. Its import manifest records the source revision and file checksums; the website does not maintain a second implementation. This app can run on its own without the website.

The stopping point is a complete batch prepare → compare → download workflow. Native packaging, offline installation, per-image crop/editing, extra formats and a hosted public release are future work. The current preview has a noindex guard; review that separately before a public deployment.

## License

Copyright (c) 2026 Wei Xian. ImagePrep is available under the [MIT License](LICENSE), which permits use, modification and redistribution, including commercial use, while preserving the copyright and license notice. The software is provided without warranty. Builds include the license in `dist/LICENSE`; keep it with copies you distribute.

The package's `private: true` prevents accidental npm publishing and does not control GitHub visibility. Source availability does not deploy a hosted service; local preview and static hosting remain separate choices. The Elystra-V website has its own separate repository and publication status.
