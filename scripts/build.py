"""Prepare the static app. No bundler, downloads or framework required."""
from pathlib import Path
import shutil

root = Path(__file__).resolve().parent.parent
dest = root / 'dist'
runtime = ('LICENSE', 'index.html', 'icon.svg', 'src/app.js', 'src/archive.js',
           'src/batch.js', 'src/core.js', 'src/processor.js', 'src/style.css')
# Export only app files, and never retain stale files from an older build.
for name in runtime:
    source = root / name
    if source.is_symlink() or not source.is_file():
        raise SystemExit(f'Expected a regular runtime file: {name}')
if dest.is_symlink():
    raise SystemExit('Refusing to replace a symlinked dist directory')
if dest.exists():
    shutil.rmtree(dest)
dest.mkdir()
for name in runtime:
    target = dest / name
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(root / name, target)
print(f'ImagePrep ready in {dest}')
