"""Prepare the static app. No bundler, downloads or framework required."""
from pathlib import Path
import shutil

root = Path(__file__).resolve().parent.parent
dest = root / 'dist'
dest.mkdir(exist_ok=True)
for name in ('index.html', 'icon.svg'):
    shutil.copy2(root / name, dest / name)
shutil.copytree(root / 'src', dest / 'src', dirs_exist_ok=True)
print(f'ImagePrep ready in {dest}')
