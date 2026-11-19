#!/usr/bin/env python3
"""Apply the current CI-verified Pactaris main revision from GitHub."""

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import HTTPRedirectHandler, Request, build_opener

API = 'https://api.github.com/repos/CoyWorks/Pactaris'
SHA = re.compile(r'[0-9a-f]{40}')
COMPONENTS = ('gateway', 'instance', 'identity')


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class GitHub:
    def __init__(self, token):
        self.token = token
        self.opener = build_opener(NoRedirect())

    def request(self, path, data=None):
        headers = {'Accept': 'application/vnd.github+json',
                   'Authorization': f'Bearer {self.token}',
                   'Content-Type': 'application/json'}
        body = None if data is None else json.dumps(data).encode()
        request = Request(API + path, data=body, headers=headers)
        with self.opener.open(request, timeout=10) as response:
            content = response.read(8_000_001)
            if len(content) > 8_000_000:
                raise ValueError('response_too_large')
            return json.loads(content)

    def main_head(self):
        value = self.request('/git/ref/heads/main')['object']
        if value['type'] != 'commit' or not SHA.fullmatch(value['sha']):
            raise ValueError('invalid_ref')
        return value['sha']

    def approved(self, revision):
        query = urlencode({'head_sha': revision, 'branch': 'main', 'event': 'push', 'per_page': 1})
        runs = self.request('/actions/workflows/ci.yml/runs?' + query)['workflow_runs']
        return bool(runs and runs[0]['head_sha'] == revision
                    and runs[0]['head_branch'] == 'main' and runs[0]['event'] == 'push'
                    and runs[0]['status'] == 'completed' and runs[0]['conclusion'] == 'success')

    def status(self, revision, mode, outcome, description):
        context = 'pactaris/live' if mode == 'apply' else 'pactaris/live-preflight'
        self.request(f'/statuses/{revision}', {
            'state': outcome, 'description': description, 'context': context,
        })


def event(name, **fields):
    print(json.dumps({'event': name, **fields}), flush=True)


def write_state(path, value):
    with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, delete=False) as handle:
        pending = Path(handle.name)
        try:
            json.dump(value, handle)
            handle.flush()
            os.fsync(handle.fileno())
            os.replace(pending, path)
            fd = os.open(path.parent, os.O_DIRECTORY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
        finally:
            pending.unlink(missing_ok=True)


def installed_revisions(root):
    revisions = {}
    for component in COMPONENTS:
        value = json.loads((root / component / 'state.json').read_text())['revision']
        if not SHA.fullmatch(value):
            raise ValueError('invalid_installed_revision')
        revisions[component] = value
    return revisions


def reconcile(github, mode, root, updater, state_path, repository=None):
    previous = json.loads(state_path.read_text()) if state_path.exists() else {}
    if previous.get('phase') == 'running':
        # A stopped process may have activated one component. Report and never replay it.
        previous.update(phase='report', result='failure', detail='Interrupted; check host journal')
        write_state(state_path, previous)
    if previous.get('phase') == 'report':
        github.status(previous['revision'], previous['mode'], previous['result'], previous['detail'])
        previous['phase'] = 'done'
        write_state(state_path, previous)
    if previous.get('phase') == 'done' and previous.get('result') == 'failure':
        event('deployment_paused', revision=previous['revision'])
        return 1

    revision = github.main_head()
    if previous.get('mode') == mode and previous.get('revision') == revision:
        return 0
    if not github.approved(revision):
        event('deployment_waiting_for_main_ci', revision=revision)
        return 0
    if github.main_head() != revision:
        event('deployment_ref_changed')
        return 0

    before = installed_revisions(root)
    github.status(revision, mode, 'pending', 'Pactaris updater started')
    current = {'revision': revision, 'mode': mode, 'phase': 'running'}
    write_state(state_path, current)

    command = ['/bin/bash', str(updater), '--root', str(root), '--revision', revision]
    if repository:
        command.extend(['--repository', repository])
    if mode == 'plan':
        command.append('--check')
    env = {key: value for key, value in os.environ.items() if key != 'CREDENTIALS_DIRECTORY'}
    try:
        result = subprocess.run(command, env=env, check=False).returncode
        after = installed_revisions(root)
        verified = result == 0 and (before == after if mode == 'plan' else
                                    after['gateway'] == revision and after['instance'] == revision)
        event('deployment_checked', revision=revision, mode=mode, passed=verified, installed=after)
    except (ValueError, OSError, KeyError, TypeError):
        verified = False
    current.update(phase='report', result='success' if verified else 'failure',
                   detail=('Preflight passed; no release activated' if mode == 'plan' else 'Updater and health checks passed')
                   if verified else 'Updater or revision check failed; check host journal')
    write_state(state_path, current)
    github.status(revision, mode, current['result'], current['detail'])
    current['phase'] = 'done'
    write_state(state_path, current)
    return 0 if verified else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode', choices=('plan', 'apply'), default='plan')
    parser.add_argument('--root', type=Path, default=Path('/opt/pactaris'))
    parser.add_argument('--updater', type=Path, default=Path('/opt/pactaris-source/update.sh'))
    parser.add_argument('--repository')
    parser.add_argument('--state', type=Path, required=True)
    args = parser.parse_args()
    try:
        token = (Path(os.environ['CREDENTIALS_DIRECTORY']) / 'github-token').read_text().strip()
        if not re.fullmatch(r'[A-Za-z0-9_]+', token):
            raise ValueError('invalid_credential')
        return reconcile(GitHub(token), args.mode, args.root, args.updater, args.state, args.repository)
    except HTTPError as error:
        event('github_request_failed', status=error.code)
    except (KeyError, TypeError, ValueError, OSError) as error:
        event('deployment_error', category=type(error).__name__)
    return 1


if __name__ == '__main__':
    raise SystemExit(main())
