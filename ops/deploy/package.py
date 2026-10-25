#!/usr/bin/env python3
"""Create a deterministic, secret-free release from a checked-out trusted SHA."""
import argparse
import io
import json
from pathlib import Path
import re
import tarfile

p = argparse.ArgumentParser()
p.add_argument('sha')
p.add_argument('output', type=Path)
a = p.parse_args()
if not re.fullmatch(r'[0-9a-f]{40}', a.sha):
    p.error('full Git SHA required')
roots = [Path('backend/src'), Path('backend/node_modules'), Path('jarvis-app/web/dist')]
for root in roots:
    if not root.is_dir():
        p.error(f'missing release tree: {root}')
with tarfile.open(a.output, 'w:gz') as archive:
    for root in roots:
        for path in sorted(root.rglob('*')):
            if path.is_symlink():
                p.error('symlinks are forbidden')
            if path.is_file():
                if any(part.startswith('.env') or part == 'users.key' for part in path.parts):
                    p.error('secret filenames are forbidden')
                if root == Path('backend/src') and path.suffix != '.mjs':
                    p.error('backend source release accepts .mjs files only')
                info = archive.gettarinfo(str(path))
                info.uid = info.gid = 0
                info.uname = info.gname = ''
                info.mode = 0o644
                with path.open('rb') as data:
                    archive.addfile(info, data)
    data = json.dumps({'sha': a.sha}).encode()
    info = tarfile.TarInfo('release.json')
    info.mode, info.size = 0o644, len(data)
    archive.addfile(info, io.BytesIO(data))
