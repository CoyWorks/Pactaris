import sys
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / 'scripts'))
import load_probe


class FakeResponse:
    status = 200
    def __enter__(self): return self
    def __exit__(self, *args): return False
    def read(self, size): return b'{}'


class LoadProbeTests(unittest.TestCase):
    def test_bounds_reject_unsafe_targets_and_unbounded_runs(self):
        self.assertEqual(load_probe.validate('https://pactaris.app/', 10, 60, 60), 'https://pactaris.app')
        for args in [('http://pactaris.app', 10, 60, 60), ('https://pactaris.app/api', 10, 60, 60), ('https://u:p@pactaris.app', 10, 60, 60),
                     ('https://pactaris.app', 0, 60, 60), ('https://pactaris.app', 201, 60, 60), ('https://pactaris.app', 10, 5, 60),
                     ('https://pactaris.app', 10, 901, 60), ('https://pactaris.app', 10, 60, 0)]:
            with self.assertRaises(ValueError):
                load_probe.validate(*args)

    def test_clients_send_only_read_requests_and_report_percentiles(self):
        requests, samples, statuses, lock = [], [], {}, threading.Lock()
        def opener(request, timeout, context):
            requests.append((request.get_method(), request.full_url))
            return FakeResponse()
        load_probe.client('https://pactaris.app', '__Host-pactaris-session=x', 1, time.monotonic() + 0.05, True, samples, statuses, lock, opener)
        self.assertTrue(requests)
        self.assertTrue(all(method == 'GET' and url.startswith('https://pactaris.app/api/') for method, url in requests))
        report = load_probe.summarize([10, 20, 30, 40, None], {'200': 4, 'error': 1}, 60)
        self.assertEqual(report['latencyMs']['p50'], 20)
        self.assertEqual(report['requests'], 5)

    def test_session_is_required_from_the_environment_not_arguments(self):
        with self.assertRaises(SystemExit):
            load_probe.main(['--origin', 'https://pactaris.app', '--seconds', '10'])


if __name__ == '__main__':
    unittest.main()
