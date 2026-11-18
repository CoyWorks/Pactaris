"""Real PostgreSQL command/RLS tests without network sockets; no production access."""
import glob
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class SchedulerPostgresTest(unittest.TestCase):
    def test_scheduler_transactions_and_calendar(self):
        candidates = sorted(glob.glob('/usr/lib/postgresql/*/bin/postgres'))
        if not candidates or os.geteuid() == 0:
            self.skipTest('unprivileged local PostgreSQL binaries required')
        binary = Path(candidates[-1])
        with tempfile.TemporaryDirectory(prefix='pactaris-scheduler-test-') as folder:
            data = Path(folder) / 'data'
            subprocess.run([str(binary.with_name('initdb')), '-D', str(data), '-A', 'trust'], check=True, capture_output=True)
            sql = ["BEGIN; CREATE ROLE scheduler_owner NOSUPERUSER NOBYPASSRLS; CREATE ROLE scheduler_runtime NOSUPERUSER NOBYPASSRLS; GRANT CREATE ON DATABASE postgres TO scheduler_owner; SET ROLE scheduler_owner;"]
            sql.extend(p.read_text() for p in sorted(Path('migrations/instance').glob('*.sql')))
            sql.append(Path('tests/fixtures/task_scheduler.sql').read_text())
            sql.append("""GRANT USAGE ON SCHEMA pactaris TO scheduler_runtime;
GRANT EXECUTE ON FUNCTION pactaris.partner_command(uuid,uuid,uuid,uuid,text,jsonb,text),pactaris.run_task_scheduler(uuid) TO scheduler_runtime;
SET ROLE scheduler_runtime;
DO $$BEGIN
 BEGIN PERFORM * FROM pactaris.task_series;RAISE EXCEPTION 'runtime read permitted';EXCEPTION WHEN insufficient_privilege THEN NULL;END;
 BEGIN PERFORM pactaris.generate_task_series(NULL,NULL,NULL,NULL);RAISE EXCEPTION 'helper callable';EXCEPTION WHEN insufficient_privilege THEN NULL;END;
 BEGIN PERFORM pactaris.partner_command_before_scheduling(NULL,NULL,NULL,NULL,NULL,NULL,NULL);RAISE EXCEPTION 'base callable';EXCEPTION WHEN insufficient_privilege THEN NULL;END;
END$$;
SELECT pactaris.run_task_scheduler('10000000-0000-4000-8000-000000000002');
ROLLBACK;""")
            # -j accepts multiline SQL until a blank line; remove interior blanks.
            source = '\n\n'.join('\n'.join(line for line in block.splitlines() if line.strip()) for block in sql) + '\n\n'
            result = subprocess.run([str(binary), '--single', '-j', '-D', str(data), 'postgres'], input=source, text=True, capture_output=True, timeout=60)
            errors = '\n'.join(line for line in (result.stdout + result.stderr).splitlines() if 'ERROR:' in line or 'FATAL:' in line)
            self.assertEqual(result.returncode, 0, result.stderr[-3000:])
            self.assertEqual(errors, '', errors[:6000])
