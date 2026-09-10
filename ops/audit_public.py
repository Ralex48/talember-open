#!/usr/bin/env python3
"""Offline publication guard. Reports paths and rule names, never matched values.

This is a review aid, not proof that a repository contains no secrets. Run it on
the clean export, then review licenses, binary assets and configuration manually.
"""
import argparse
import hashlib
import pathlib
import re
import subprocess
import sys

RULES = {
    'private-key': re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
    'github-token': re.compile(r'\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})'),
    'provider-token': re.compile(r'\bsk-[A-Za-z0-9_-]{24,}'),
    'aws-key': re.compile(r'\bAKIA[A-Z0-9]{16}\b'),
    'private-ip': re.compile(r'\b(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b'),
    'personal-home': re.compile(r'/(?:Users|home)/[a-zA-Z][a-zA-Z0-9_-]+/'),
}
FORBIDDEN = {'.env', '.dev.vars', 'deploy.env', '.runner', '.credentials', 'inventory.local.yml'}

def inspect(root, deny=()):
    paths = subprocess.check_output(['git', '-C', str(root), 'ls-files', '-z']).decode().split('\0')
    findings = []
    for relative in filter(None, paths):
        path = root / relative
        if path.is_symlink():
            findings.append((relative, 'symlink')); continue
        if path.name in FORBIDDEN:
            findings.append((relative, 'private-file'))
        try:
            text = path.read_text(encoding='utf-8')
        except UnicodeDecodeError:
            allowed = relative.startswith('renderer/fonts/') and path.suffix == '.ttf'
            allowed |= relative in ('tests/service/synthetic-video.mp4', 'tests/service/synthetic-video-landscape.mp4')
            if relative == 'public/assets/preview/demo.mp4':
                fixture=root/'tests/service/synthetic-video-landscape.mp4'
                allowed=fixture.exists() and hashlib.sha256(path.read_bytes()).digest()==hashlib.sha256(fixture.read_bytes()).digest()
            if not allowed:
                findings.append((relative, 'unreviewed-binary'))
            continue
        for rule, pattern in RULES.items():
            if pattern.search(text): findings.append((relative, rule))
        if any(value and value in text for value in deny):
            findings.append((relative, 'private-literal'))
        if relative.startswith('.github/workflows/'):
            if 'self-hosted' in text or 'pull_request_target:' in text:
                findings.append((relative, 'unsafe-public-runner'))
    return findings

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('root', type=pathlib.Path)
    parser.add_argument('--deny-file', type=pathlib.Path, help='Private newline-separated literals to exclude')
    args = parser.parse_args()
    deny = args.deny_file.read_text().splitlines() if args.deny_file else []
    findings = inspect(args.root.resolve(), deny)
    for path, rule in findings: print(f'{path}: {rule}')
    print(f'Publication audit: {len(findings)} finding(s)')
    return bool(findings)

if __name__ == '__main__':
    sys.exit(main())
