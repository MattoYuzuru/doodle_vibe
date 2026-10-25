#!/usr/bin/env python3
"""Synthetic release/rollback boundary checks; no SSH, service or real data access."""
from contextlib import closing
import hashlib
import importlib.util
import io
import shutil
import json
from pathlib import Path
import subprocess
import sqlite3
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('handler', Path(__file__).with_name('handler.py'))
handler = importlib.util.module_from_spec(spec)
spec.loader.exec_module(handler)
A, B = 'a' * 40, 'b' * 40


def bundle(extra=None):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w:gz') as archive:
        files = {'release.json': json.dumps({'sha': A}).encode(), 'backend/src/main.mjs': b'', 'jarvis-app/web/dist/index.html': b'<!doctype html>'}
        if extra:
            files.update(extra)
        for name, value in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(value)
            archive.addfile(info, io.BytesIO(value))
    return output.getvalue()


class HandlerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.base = Path(self.temporary.name)
        (self.base / 'releases').mkdir()
        self.base_patch = patch.object(handler, 'BASE', self.base)
        self.base_patch.start()
        self.db_patch = patch.object(handler, 'DATABASE', self.base / 'fixture.sqlite')
        self.backup_patch = patch.object(handler, 'BACKUPS', self.base / 'backups')
        self.db_patch.start()
        self.backup_patch.start()

    def tearDown(self):
        self.backup_patch.stop()
        self.db_patch.stop()
        self.base_patch.stop()
        self.temporary.cleanup()

    def install(self, data):
        with patch.object(handler.sys, 'stdin', type('Input', (), {'buffer': io.BytesIO(data)})()), patch.object(handler, 'activate') as activate:
            handler.install(A, hashlib.sha256(data).hexdigest())
            return activate

    def health(self, data):
        class Opener:
            def open(self, *_args, **_kwargs):
                response = io.BytesIO(data)
                response.status = 200
                return response
        with patch.object(handler.urllib.request, 'build_opener', return_value=Opener()), patch.object(handler.time, 'sleep'):
            return handler.healthy(A)

    def test_health_allows_additional_readiness_fields(self):
        self.assertTrue(self.health(json.dumps({'status': 'ok', 'version': A, 'ready': False, 'components': {'telegram': False}}).encode()))

    def test_health_rejects_wrong_version_and_malformed_responses(self):
        for data in [json.dumps({'status': 'ok', 'version': B}).encode(), b'{malformed', b'[]', b'null', b'{"version":"' + A.encode() + b'"}']:
            with self.subTest(data=data):
                self.assertFalse(self.health(data))

    def test_valid_archive_is_immutable_and_generates_version(self):
        activate = self.install(bundle())
        activate.assert_called_once_with(A)
        self.assertEqual((self.base / 'releases' / A).stat().st_mode & 0o777, 0o755)
        self.assertEqual((self.base / 'releases' / A / 'release.env').read_text(), f'APP_VERSION={A}\n')
        with self.assertRaisesRegex(RuntimeError, 'immutable'):
            self.install(bundle())

    def test_traversal_and_unexpected_paths_rejected_before_activation(self):
        for name in ['backend/src/../../../escape', '/etc/shadow', 'backend/.env', 'backend/src/.env', 'backend/src/key.txt', 'jarvis-app/web/dist/.env.local', 'release.env']:
            with self.subTest(name=name), self.assertRaisesRegex(RuntimeError, 'unsafe'):
                self.install(bundle({name: b'bad'}))
        self.assertFalse((self.base / 'releases' / A).exists())

    def test_database_backup_preserves_committed_rows(self):
        with closing(sqlite3.connect(handler.DATABASE)) as db:
            db.execute('create table fixture (value text)')
            db.execute("insert into fixture values ('synthetic')")
            db.commit()
        handler.backup_database()
        backup, = handler.BACKUPS.iterdir()
        self.assertEqual(backup.stat().st_mode & 0o777, 0o600)
        with closing(sqlite3.connect(backup)) as db:
            self.assertEqual(db.execute('select value from fixture').fetchone(), ('synthetic',))

    def test_symlink_rejected(self):
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode='w:gz') as archive:
            info = tarfile.TarInfo('backend/src/link')
            info.type, info.linkname = tarfile.SYMTYPE, '/etc'
            archive.addfile(info)
        with self.assertRaisesRegex(RuntimeError, 'unsafe'):
            self.install(output.getvalue())

    def test_bad_digest_cannot_activate(self):
        data = bundle()
        with patch.object(handler.sys, 'stdin', type('Input', (), {'buffer': io.BytesIO(data)})()), self.assertRaisesRegex(RuntimeError, 'checksum'):
            handler.install(A, '0' * 64)
        self.assertFalse((self.base / 'releases' / A).exists())

    def test_restart_failure_restores_and_checks_previous(self):
        for sha in (A, B):
            (self.base / 'releases' / sha).mkdir()
        handler.point('current', B)
        with patch.object(handler, 'run', side_effect=[subprocess.CalledProcessError(1, 'systemctl'), None]) as run, patch.object(handler, 'healthy', return_value=True) as healthy:
            with self.assertRaisesRegex(RuntimeError, 'previous state restored'):
                handler.activate(A)
            self.assertEqual(handler.current_sha(), B)
            self.assertEqual(run.call_count, 2)
            healthy.assert_called_once_with(B)

    def test_failed_first_release_stops_service_and_removes_current(self):
        (self.base / 'releases' / A).mkdir()
        with patch.object(handler, 'run') as run, patch.object(handler, 'healthy', return_value=False):
            with self.assertRaisesRegex(RuntimeError, 'previous state restored'):
                handler.activate(A)
            self.assertIsNone(handler.current_sha())
            self.assertEqual(run.call_args.args, ('/usr/bin/systemctl', 'stop', handler.SERVICE))

    def test_success_records_previous_without_changing_its_files(self):
        for sha in (A, B):
            (self.base / 'releases' / sha).mkdir()
        handler.point('current', B)
        with patch.object(handler, 'run'), patch.object(handler, 'healthy', return_value=True):
            handler.activate(A)
        self.assertEqual(handler.current_sha(), A)
        self.assertEqual(handler.current_sha('previous'), B)

    def test_scripts_directory_accepts_only_mjs(self):
        self.install(bundle({'backend/scripts/chromium-smoke.mjs': b''}))
        shutil.rmtree(self.base / 'releases', ignore_errors=True)
        (self.base / 'releases').mkdir()
        with self.assertRaisesRegex(RuntimeError, 'unsafe'):
            self.install(bundle({'backend/scripts/run.sh': b''}))

    def test_smoke_requires_current_release_with_script(self):
        for sha in (A, B):
            (self.base / 'releases' / sha).mkdir()
        handler.point('current', A)
        with patch.object(handler, 'run') as run:
            with self.assertRaisesRegex(RuntimeError, 'current release'):
                handler.smoke(B)
            with self.assertRaisesRegex(RuntimeError, 'no chromium smoke'):
                handler.smoke(A)
            run.assert_not_called()

    def test_smoke_reports_unit_failure_without_success(self):
        script = self.base / 'releases' / A / 'backend/scripts'
        script.mkdir(parents=True)
        (script / 'chromium-smoke.mjs').write_text('')
        handler.point('current', A)
        done = subprocess.CompletedProcess([], 0, stdout='{"ok":false}\n')
        with patch.object(handler, 'run', side_effect=subprocess.CalledProcessError(1, 'systemctl')), patch.object(handler.subprocess, 'run', return_value=done):
            with self.assertRaisesRegex(RuntimeError, 'smoke failed'):
                handler.smoke(A)

    def test_smoke_unit_keeps_the_backend_sandbox_and_bounded_limits(self):
        def directives(name):
            lines = (Path(__file__).with_name(name)).read_text().splitlines()
            return {line for line in lines if '=' in line and not line.startswith(('#', '[', 'Exec', 'Environment', 'Description', 'Type', 'Timeout', 'Restart', 'Kill', 'Working', 'After', 'Wants', 'StandardOutput', 'StandardError', 'WantedBy'))}
        backend, smoke = directives('doodle-backend.service'), directives('doodle-chromium-smoke.service')
        hardening = {line for line in backend if line.split('=')[0] not in ('MemoryMax', 'TasksMax', 'RestartSec')}
        self.assertLessEqual(hardening, smoke)
        self.assertIn('CapabilityBoundingSet=', smoke)
        self.assertIn('NoNewPrivileges=true', smoke)
        self.assertTrue(any(line.startswith('MemoryMax=') for line in smoke))
        self.assertIn('chromiumSandbox: true', (Path(__file__).parents[2] / 'backend/scripts/chromium-smoke.mjs').read_text())


class PackageTests(unittest.TestCase):
    def package(self, link_in):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name in ('backend/src', 'backend/scripts', 'backend/node_modules/.bin', 'backend/node_modules/lib', 'jarvis-app/web/dist'):
                (root / name).mkdir(parents=True)
            (root / 'backend/src/main.mjs').write_text('')
            (root / 'jarvis-app/web/dist/index.html').write_text('x')
            (root / 'backend/node_modules/lib/cli.js').write_text('')
            (root / link_in).symlink_to('../lib/cli.js' if '.bin' in link_in else 'cli.js')
            result = subprocess.run(['python3', str(Path(__file__).with_name('package.py')), A, str(root / 'out.tgz')], cwd=root, capture_output=True, text=True)
            names = tarfile.open(root / 'out.tgz').getnames() if result.returncode == 0 else []
            return result, names

    def test_npm_bin_symlinks_are_skipped(self):
        result, names = self.package('backend/node_modules/.bin/tool')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('backend/node_modules/lib/cli.js', names)
        self.assertFalse([name for name in names if '.bin' in name])

    def test_other_symlinks_are_still_rejected(self):
        result, _ = self.package('backend/node_modules/lib/link')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('symlinks are forbidden', result.stderr)


if __name__ == '__main__':
    unittest.main()
