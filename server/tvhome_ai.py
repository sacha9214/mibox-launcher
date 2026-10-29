#!/usr/bin/env python3
"""tvhome-ai: names the film or show someone describes on their phone, for the LG home screen (webos/).

Runs on a server where Claude Code is logged in with a Claude subscription (claude -p, no tools, no MCP). Its only
client is the TV's service: HTTPS with a self-signed certificate that the TV pins, and a shared token.

    python3 tvhome_ai.py          # serves on :8791; makes token, cert.pem and key.pem here on the first run
    python3 tvhome_ai.py --setup  # only makes them, and prints what webos/ai.local.json needs

The answer is up to three guesses, most likely first: {"results": [{"title", "original_title", "year", "type"}]}.
The TV then looks each one up on JustWatch (where to watch it in France).
"""
import hmac
import json
import os
import re
import secrets
import subprocess
import sys
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ssl

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get('TVHOME_AI_PORT', '8791'))
HOST_IP = os.environ.get('TVHOME_AI_IP', '141.227.149.33')   # in the certificate, so the TV can check it
CLAUDE = os.path.expanduser(os.environ.get('TVHOME_AI_CLAUDE', '~/.local/bin/claude'))
MODEL = os.environ.get('TVHOME_AI_MODEL', 'sonnet')
PER_HOUR = 30            # the subscription's usage is shared with everything else: a family needs far fewer
TOKEN_FILE, CERT, KEY = (os.path.join(HERE, n) for n in ('token', 'cert.pem', 'key.pem'))
EMPTY = os.path.join(HERE, 'empty')   # claude runs in an empty folder: nothing of this server to read

PROMPT = """Tu aides une famille française à retrouver un film ou une série à partir d'une description, souvent vague, \
tapée ou dictée sur un téléphone (fautes possibles). Donne jusqu'à 3 propositions, de la plus probable à la moins \
probable. Si la description nomme déjà un titre, ce titre d'abord.
Réponds UNIQUEMENT avec ce JSON, sans texte autour :
{"results":[{"title":"titre connu en France","original_title":"titre original","year":2011,"type":"show"}]}
type vaut "movie" (film) ou "show" (série). Si rien ne correspond, {"results":[]}.

Description : """

calls = deque()
lock = threading.Lock()


def setup():
    os.makedirs(EMPTY, exist_ok=True)
    if not os.path.exists(TOKEN_FILE):
        with open(TOKEN_FILE, 'w') as f:
            f.write(secrets.token_urlsafe(32))
        os.chmod(TOKEN_FILE, 0o600)
    if not os.path.exists(CERT):
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '3650',
                        '-keyout', KEY, '-out', CERT, '-subj', '/CN=tvhome-ai',
                        '-addext', 'subjectAltName=IP:' + HOST_IP], check=True, capture_output=True)
        os.chmod(KEY, 0o600)
    with open(TOKEN_FILE) as f:
        return f.read().strip()


def ask_claude(q):
    """Claude's guesses for a description: [{title, original_title, year, type}]."""
    out = subprocess.run([CLAUDE, '-p', PROMPT + q, '--output-format', 'json', '--model', MODEL, '--tools', '',
                          '--strict-mcp-config', '--no-session-persistence'],
                         cwd=EMPTY, capture_output=True, text=True, timeout=90)
    text = json.loads(out.stdout).get('result', '')
    m = re.search(r'\{.*\}', text, re.S)   # the JSON, even if it comes in a code block
    results = json.loads(m.group(0)).get('results', []) if m else []
    clean = []
    for r in results[:3]:
        if isinstance(r, dict) and r.get('title'):
            clean.append({'title': str(r['title'])[:120], 'original_title': str(r.get('original_title') or '')[:120],
                          'year': r.get('year') if isinstance(r.get('year'), int) else None,
                          'type': 'show' if r.get('type') == 'show' else 'movie'})
    return clean


class Handler(BaseHTTPRequestHandler):
    def reply(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path != '/ask':
            return self.reply(404, {'error': 'not found'})
        auth = self.headers.get('Authorization', '')
        if not hmac.compare_digest(auth.encode(), ('Bearer ' + TOKEN).encode()):
            return self.reply(401, {'error': 'token'})
        try:
            n = min(int(self.headers.get('Content-Length', '0')), 4096)
            q = str(json.loads(self.rfile.read(n) or b'{}').get('q', '')).strip()[:500]
        except (ValueError, json.JSONDecodeError):
            return self.reply(400, {'error': 'bad request'})
        if not q:
            return self.reply(400, {'error': 'empty'})
        now = time.time()
        while calls and now - calls[0] > 3600:
            calls.popleft()
        if len(calls) >= PER_HOUR:
            return self.reply(429, {'error': 'too many'})
        calls.append(now)
        started = time.time()
        try:
            with lock:   # one at a time: the subscription isn't a batch service
                results = ask_claude(q)
        except Exception as e:  # noqa: BLE001 — any failure is one answer for the TV
            print('ask failed: %r' % e, flush=True)
            return self.reply(502, {'error': 'claude'})
        print('%s %.1fs %d result(s)' % (time.strftime('%F %T'), time.time() - started, len(results)), flush=True)
        self.reply(200, {'results': results})

    def log_message(self, *args):
        pass   # no request log: the descriptions are the family's


if __name__ == '__main__':
    TOKEN = setup()
    if '--setup' in sys.argv:
        with open(CERT) as f:
            print(json.dumps({'url': 'https://%s:%d/ask' % (HOST_IP, PORT), 'token': TOKEN, 'cert': f.read()}))
        sys.exit(0)
    server = ThreadingHTTPServer(('0.0.0.0', PORT), Handler)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(CERT, KEY)
    server.socket = ctx.wrap_socket(server.socket, server_side=True)
    print('tvhome-ai on :%d (%s)' % (PORT, MODEL), flush=True)
    server.serve_forever()
