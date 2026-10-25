#!/usr/bin/python3
"""Root-owned fixed-purpose release handler. Never evaluates SSH input as shell."""
from contextlib import closing
import fcntl
import hashlib
import gzip
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request

BASE = Path('/srv/doodle')
SERVICE = 'doodle-backend.service'
MAX_ARCHIVE = 100 * 1024 * 1024
MAX_CONTENT = 250 * 1024 * 1024
SHA = r'[0-9a-f]{40}'
DATABASE = Path('/var/lib/doodle/platform.sqlite')
BACKUPS = Path('/var/backups/doodle')


def run(*args):
    subprocess.run(args, check=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL)


def current_sha(link='current'):
    path = BASE / link
    if not path.is_symlink():
        return None
    resolved = path.resolve()
    if resolved.parent != (BASE / 'releases').resolve() or not re.fullmatch(SHA, resolved.name):
        raise RuntimeError('invalid release link')
    return resolved.name


def point(link, sha):
    temporary = BASE / f'.{link}.next'
    temporary.unlink(missing_ok=True)
    temporary.symlink_to(f'releases/{sha}')
    temporary.replace(BASE / link)


def healthy(sha):
    for _ in range(20):
        try:
            with urllib.request.build_opener(urllib.request.ProxyHandler({})).open('http://127.0.0.1:18110/healthz', timeout=2) as response:
                result = json.load(response)
                if response.status == 200 and isinstance(result, dict) and result.get('status') == 'ok' and result.get('version') == sha:
                    return True
        except (OSError, ValueError):
            pass
        time.sleep(1)
    return False


def backup_database():
    source = DATABASE
    if not source.exists():
        return
    if source.is_symlink() or not source.is_file():
        raise RuntimeError('invalid database path')
    backups = BACKUPS
    backups.mkdir(mode=0o700, parents=True, exist_ok=True)
    backup = backups / f'platform-{time.time_ns()}.sqlite'
    deadline = time.monotonic() + 15
    def progress(*_):
        if time.monotonic() > deadline:
            raise RuntimeError('database backup timed out')
    try:
        with closing(sqlite3.connect(f'file:{source}?mode=ro', uri=True)) as original, closing(sqlite3.connect(backup)) as copy:
            original.backup(copy, pages=256, progress=progress, sleep=0.05)
        backup.chmod(0o600)
    except Exception:
        backup.unlink(missing_ok=True)
        raise


def activate(sha):
    previous = current_sha()
    point('current', sha)
    started = True
    try:
        run('/usr/bin/systemctl', 'restart', SERVICE)
        started = healthy(sha)
        if started:
            run('/usr/bin/systemctl', 'enable', SERVICE)
    except subprocess.CalledProcessError:
        started = False
    if started:
        if previous and previous != sha:
            point('previous', previous)
        print(json.dumps({'status': 'healthy', 'sha': sha, 'previous': previous}))
        return
    if previous:
        point('current', previous)
        run('/usr/bin/systemctl', 'restart', SERVICE)
        if not healthy(previous):
            raise RuntimeError('release and rollback health failed; operator intervention required')
    else:
        run('/usr/bin/systemctl', 'stop', SERVICE)
        (BASE / 'current').unlink(missing_ok=True)
    raise RuntimeError('release health failed; previous state restored')


def install(sha, digest):
    target = BASE / 'releases' / sha
    if target.exists():
        raise RuntimeError('immutable release already exists; use rollback for an existing SHA')
    with tempfile.TemporaryDirectory(prefix='.incoming-', dir=BASE) as tmp:
        archive = Path(tmp) / 'release.tar.gz'
        size = 0
        checksum = hashlib.sha256()
        with archive.open('wb') as output:
            while data := sys.stdin.buffer.read(1024 * 1024):
                size += len(data)
                if size > MAX_ARCHIVE:
                    raise RuntimeError('archive too large')
                checksum.update(data)
                output.write(data)
        if checksum.hexdigest() != digest:
            raise RuntimeError('archive checksum mismatch')
        stage = Path(tmp) / 'release'
        stage.mkdir(mode=0o755)
        seen, total = set(), 0
        plain = Path(tmp) / 'release.tar'
        expanded = 0
        with gzip.open(archive, 'rb') as compressed, plain.open('wb') as output:
            while data := compressed.read(1024 * 1024):
                expanded += len(data)
                if expanded > MAX_CONTENT + 10 * 1024 * 1024:
                    raise RuntimeError('expanded archive too large')
                output.write(data)
        with tarfile.open(plain, 'r:') as bundle:
            for count, member in enumerate(bundle, start=1):
                if count > 20000:
                    raise RuntimeError('too many archive members')
                name = member.name
                parts = PurePosixPath(name).parts
                allowed = name == 'release.json' or (name.startswith('backend/src/') and name.endswith('.mjs')) or name.startswith('backend/node_modules/') or name.startswith('jarvis-app/web/dist/')
                if any(part.startswith('.env') or part == 'users.key' for part in parts):
                    allowed = False
                if member.size < 0 or not allowed or not parts or name.startswith('/') or '..' in parts or name in seen or not member.isfile():
                    raise RuntimeError('unsafe archive member')
                seen.add(name)
                total += member.size
                if total > MAX_CONTENT:
                    raise RuntimeError('expanded archive too large')
                destination = stage / name
                destination.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
                source = bundle.extractfile(member)
                if source is None:
                    raise RuntimeError('missing archive member')
                with destination.open('xb') as output:
                    shutil.copyfileobj(source, output)
                destination.chmod(0o644)
        if json.loads((stage / 'release.json').read_text()) != {'sha': sha}:
            raise RuntimeError('release SHA mismatch')
        if not (stage / 'backend/src/main.mjs').is_file() or not (stage / 'jarvis-app/web/dist/index.html').is_file():
            raise RuntimeError('incomplete release')
        (stage / 'release.env').write_text(f'APP_VERSION={sha}\n')
        (stage / 'release.env').chmod(0o644)
        for directory in stage.rglob('*'):
            if directory.is_dir():
                directory.chmod(0o755)
        stage.chmod(0o755)
        stage.rename(target)
    backup_database()
    activate(sha)


def main():
    if os.getuid() != 0 or len(sys.argv) != 2:
        raise RuntimeError('restricted handler requires exactly one command')
    os.umask(0o077)
    command = sys.argv[1]
    with (BASE / '.deploy.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if command == 'status':
            print(json.dumps({'current': current_sha(), 'previous': current_sha('previous')}))
        elif match := re.fullmatch(f'install ({SHA}) ([0-9a-f]{{64}})', command):
            install(*match.groups())
        elif match := re.fullmatch(f'rollback ({SHA})', command):
            sha = match[1]
            if sha != current_sha('previous'):
                raise RuntimeError('rollback must name the previous release')
            activate(sha)
        else:
            raise RuntimeError('command denied')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Exception details never include archive bytes, secrets, or environment values.
        print(f'deployment failed: {type(error).__name__}: {error}', file=sys.stderr)
        sys.exit(1)
