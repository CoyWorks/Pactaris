#!/usr/bin/env python3
"""Plan by default; delete only feature refs fully contained in the default branch."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import quote

MESSAGES = json.loads((Path(__file__).resolve().parents[1] / 'locales/en/messages.json').read_text())

def emit(key, **fields):
    print(json.dumps({'messageKey': key, 'message': MESSAGES[key], **fields}))

def run(argv, optional=False):
    env = {**os.environ, 'GIT_TERMINAL_PROMPT': '0', 'GH_PROMPT_DISABLED': '1'}
    result = subprocess.run(argv, text=True, capture_output=True, env=env, timeout=90)
    if result.returncode and not optional:
        raise RuntimeError('command.failed')
    return result

def api(path, pages=False):
    command = ['gh', 'api'] + (['--paginate', '--slurp'] if pages else []) + [path]
    return json.loads(run(command).stdout)

def contained(comparison, feature_sha):
    return comparison.get('status') in ('ahead', 'identical') and comparison.get('behind_by') == 0 and comparison.get('merge_base_commit', {}).get('sha') == feature_sha

def cleanup(repository, apply=False):
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository):
        raise ValueError('repository.invalid')
    root = 'repos/' + repository
    default = api(root)['default_branch']
    reference = api(root + '/git/ref/heads/' + quote(default, safe='/'))['object']['sha']
    local = run(['git', 'symbolic-ref', '--quiet', '--short', 'HEAD'], optional=True)
    current = local.stdout.strip() if local.returncode == 0 else None
    pages = api(root + '/branches?per_page=100', pages=True)
    candidates = []
    for branch in [item for page in pages for item in page]:
        name, sha = branch['name'], branch['commit']['sha']
        if not name.startswith('feature/') or name == current or name == default or branch['protected']:
            continue
        comparison = api(root + '/compare/' + sha + '...' + reference + '?per_page=1')
        if contained(comparison, sha):
            candidates.append((name, sha))
            emit('cli.branchPlan', branch=name, revision=sha, reference=reference)
    if not apply:
        return len(candidates), 0
    removed = 0
    for name, sha in candidates:
        if api(root + '/git/ref/heads/' + quote(default, safe='/'))['object']['sha'] != reference:
            raise RuntimeError('reference.changed')
        if api(root + '/git/ref/heads/' + quote(name, safe='/'))['object']['sha'] != sha:
            emit('cli.branchChanged', branch=name)
            continue
        # Per-command credential helper uses existing gh authentication, without
        # copying tokens into arguments, URLs, logs, config files or environment.
        # The server-side lease rejects a branch advanced since the last read.
        run(['git', '-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential',
             'push', '--porcelain', '--force-with-lease=refs/heads/' + name + ':' + sha,
             'https://github.com/' + repository + '.git', ':refs/heads/' + name])
        removed += 1
        emit('cli.branchDeleted', branch=name, revision=sha)
    return len(candidates), removed

def main():
    parser = argparse.ArgumentParser(description=MESSAGES['cli.branchHelp'])
    parser.add_argument('--repository', default='CoyWorks/Pactaris')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    try:
        planned, removed = cleanup(args.repository, args.apply)
        emit('cli.branchComplete', planned=planned, deleted=removed, applied=args.apply)
        return 0
    except (OSError, RuntimeError, ValueError, KeyError, subprocess.SubprocessError):
        emit('cli.branchFailed')
        return 1

if __name__ == '__main__':
    sys.exit(main())
