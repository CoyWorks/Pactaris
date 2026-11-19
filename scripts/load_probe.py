#!/usr/bin/env python3
"""Bounded read-only polling load probe for a deployed Pactaris gateway (#31).

Simulates visible clients that poll the same read endpoints the app polls, using one
synthetic test account's session cookie. It sends only GET requests, never mutations,
and stops after a fixed duration. Run it from outside the deployment network against a
pilot or staging origin, never with a real person's session.
"""

import argparse
import json
import math
import os
import random
import ssl
import statistics
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

READ_PATHS = ('/api/session', '/api/households')
MAX_CLIENTS = 200
MAX_SECONDS = 900


def percentile(values, fraction):
    if not values:
        return None
    ordered = sorted(values)
    # Nearest-rank percentile: the smallest value with at least this share of samples at or below it.
    index = min(len(ordered) - 1, max(0, math.ceil(fraction * len(ordered)) - 1))
    return round(ordered[index], 1)


def summarize(samples, statuses, seconds):
    latencies = [value for value in samples if value is not None]
    return {
        'requests': len(samples), 'durationSeconds': seconds,
        'statuses': dict(sorted(statuses.items())),
        'latencyMs': {'p50': percentile(latencies, 0.5), 'p95': percentile(latencies, 0.95),
                      'p99': percentile(latencies, 0.99), 'max': round(max(latencies), 1) if latencies else None,
                      'mean': round(statistics.fmean(latencies), 1) if latencies else None},
    }


def validate(origin, clients, seconds, interval):
    parts = urlsplit(origin)
    if parts.scheme != 'https' or not parts.hostname or parts.path not in ('', '/') or parts.query or parts.username:
        raise ValueError('load.origin')
    if not 1 <= clients <= MAX_CLIENTS or not 10 <= seconds <= MAX_SECONDS or not 1 <= interval <= 300:
        raise ValueError('load.bounds')
    return f'{parts.scheme}://{parts.netloc}'


def client(origin, cookie, interval, deadline, burst, samples, statuses, lock, opener=urlopen):
    # Spread clients over the interval unless a synchronized reconnect burst is requested.
    time.sleep(0 if burst else random.uniform(0, interval))
    context = ssl.create_default_context()
    while time.monotonic() < deadline:
        for path in READ_PATHS:
            request = Request(origin + path, headers={'Cookie': cookie, 'Accept': 'application/json'})
            started = time.monotonic()
            try:
                with opener(request, timeout=10, context=context) as response:
                    response.read(65536)
                    status = response.status
            except HTTPError as error:
                status = error.code
            except (URLError, TimeoutError, OSError):
                status = 'error'
            elapsed = (time.monotonic() - started) * 1000
            with lock:
                samples.append(elapsed if status != 'error' else None)
                statuses[str(status)] = statuses.get(str(status), 0) + 1
        time.sleep(interval)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--origin', required=True)
    parser.add_argument('--clients', type=int, default=25)
    parser.add_argument('--seconds', type=int, default=120)
    parser.add_argument('--interval', type=int, default=60, help='poll interval per client, as in the app')
    parser.add_argument('--burst', action='store_true', help='start all clients at once (reconnect burst)')
    args = parser.parse_args(argv)
    origin = validate(args.origin, args.clients, args.seconds, args.interval)
    cookie = os.environ.get('PACTARIS_LOAD_SESSION', '')
    if not cookie.startswith('__Host-pactaris-session='):
        raise SystemExit(json.dumps({'event': 'load.session_required'}))
    samples, statuses, lock = [], {}, threading.Lock()
    deadline = time.monotonic() + args.seconds
    threads = [threading.Thread(target=client, args=(origin, cookie, args.interval, deadline, args.burst, samples, statuses, lock), daemon=True)
               for _ in range(args.clients)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=args.seconds + 30)
    report = summarize(samples, statuses, args.seconds) | {'clients': args.clients, 'intervalSeconds': args.interval, 'burst': args.burst}
    print(json.dumps({'event': 'load.report', **report}))
    return 0 if statuses and set(statuses) <= {'200'} else 1


if __name__ == '__main__':
    raise SystemExit(main())
