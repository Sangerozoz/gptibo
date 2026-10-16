#!/usr/bin/env python3
"""Check tracked source (or an exported tree) without printing matched values.

This is a release guard for private artifacts and unexpected outbound hosts.
Run Gitleaks as well; neither check is a guarantee against all disclosures.
"""
import argparse
import ipaddress
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlsplit

PUBLIC_HOSTS = {
    'api.cloudflare.com', 'challenges.cloudflare.com', 'developers.cloudflare.com',
    'api.resend.com', 'api.telegram.org', 'open.feishu.cn', 't.me',
    'openapi.alipay.com', 'openapi-sandbox.dl.alipaydev.com', 'qr.alipay.com',
    'chatgpt.com', 'api.openai.com', 'cdn.auth0.com', '5sim.net',
    'z-pay.cn',  # User-provided payment provider reference link; no API endpoint is configured.
    'github.com', 'raw.githubusercontent.com', 'registry.npmjs.org',
    'www.w3.org', 'www.apache.org', 'ui.shadcn.com', 'transitions.dev', 'vite.dev',
    'www.duolingo.com', 'www.duolingo.cn', 'd35aaqx5ub95lt.cloudfront.net',
}
# User-supplied hero PNGs were checked for valid PNG structure and Exif tag IDs.
BINARY_ASSETS = {'public/email-logo.png', 'public/email-shop.png', 'src/assets/hero.png',
                 'public/hero-heads/lightning.png', 'public/hero-heads/pink-cap.png',
                 'public/hero-heads/purple-cap.png', 'public/hero-heads/rainbow.png',
                 'public/hero-heads/red-cap.png'}
FORBIDDEN_PARTS = {'.git', '.secrets', '.imports', '.admin-auth', '.xgift-private',
                   'node_modules', 'dist', '.preview', '.wrangler', 'artifacts', '__pycache__'}
FORBIDDEN_SUFFIXES = {'.pem', '.key', '.p12', '.pfx', '.sqlite', '.db', '.dump',
                      '.backup', '.har', '.log', '.zip', '.gz', '.exe'}
SECRET = re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\r\n]+[A-Za-z0-9+/]{20}')
TOKEN = re.compile(r'\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|AKIA[A-Z0-9]{16}|sk-(?:proj-)?[A-Za-z0-9_-]{30,})\b')
URL = re.compile(r'https?://[A-Za-z0-9_.:@/-]+')
CLOUD_ID = re.compile(r'"(?:account_id|zone_id|database_id)"\s*:\s*"([a-fA-F0-9-]+)"')


def allowed_host(host):
    host = host.lower()
    if host in PUBLIC_HOSTS or host in {'localhost', '127.0.0.1', '0.0.0.0', '::1', 'example.com', 'example.org', 'example.net'}:
        return True
    if host.endswith(('.example.com', '.example.org', '.example.net', '.example', '.test', '.invalid')):
        return True
    # Explicit test fixtures for public authentication infrastructure.
    if host == 'team.cloudflareaccess.com':
        return True
    try:
        return not ipaddress.ip_address(host).is_global
    except ValueError:
        return False


def scan(root, files):
    findings = []
    for name in sorted(files):
        path = root / name
        if path.is_symlink():
            findings.append((name, 0, 'symlink forbidden in public export'))
            continue
        if not path.exists():
            continue  # Deleted tracked file in a preparation branch.
        if not path.is_file():
            continue
        parts = Path(name).parts
        if (FORBIDDEN_PARTS.intersection(parts) or path.suffix in FORBIDDEN_SUFFIXES
                or (path.name.startswith('.env') and not path.name.endswith('.example'))
                or (path.name.startswith('.dev.vars') and not path.name.endswith('.example'))
                or name.startswith(('services/platform/', 'services/xgift/'))):
            findings.append((name, 0, 'private/runtime artifact'))
            continue
        data = path.read_bytes()
        try:
            source = data.decode('utf-8')
        except UnicodeDecodeError:
            if name not in BINARY_ASSETS or not data.startswith(b'\x89PNG\r\n\x1a\n'):
                findings.append((name, 0, 'unreviewed binary asset'))
            continue
        for rule, pattern in [('private key', SECRET), ('credential token', TOKEN)]:
            for match in pattern.finditer(source):
                findings.append((name, source.count('\n', 0, match.start()) + 1, rule))
        for match in CLOUD_ID.finditer(source):
            if set(match.group(1)) - {'0', '-'}:
                findings.append((name, source.count('\n', 0, match.start()) + 1, 'non-placeholder cloud resource ID'))
        if path.name == 'package-lock.json':
            continue  # Dependency integrity is checked by npm ci and Gitleaks.
        for line, text in enumerate(source.splitlines(), 1):
            for match in URL.finditer(text):
                try:
                    host = urlsplit(match.group()).hostname or ''
                except ValueError:
                    findings.append((name, line, 'malformed URL requires review'))
                    continue
                # Ignore templates and incomplete expression/regex fragments.
                if '.' not in host or host.endswith('.'):
                    continue
                if not allowed_host(host):
                    findings.append((name, line, 'unexpected external host'))
    return sorted(set(findings))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--tree', type=Path, help='scan an exported source directory, including hidden files')
    args = parser.parse_args()
    if args.tree:
        root = args.tree.resolve()
        files = [str(p.relative_to(root)) for p in root.rglob('*') if p.is_file() or p.is_symlink()]
    else:
        root = Path(__file__).resolve().parents[1]
        files = subprocess.check_output(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], cwd=root).decode().split('\0')
        files = [name for name in files if name]
    findings = scan(root, files)
    for name, line, rule in findings:
        print(f'{name}:{line}: {rule}')
    print(f'Public-source scan: {len(files)} paths checked, {len(findings)} findings. Values are never printed.')
    return bool(findings)


if __name__ == '__main__':
    sys.exit(main())
