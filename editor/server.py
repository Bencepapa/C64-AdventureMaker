"""ADVGUI editor back end: serves the editor page and reads/writes game files.

usage: python editor/server.py [port]      then open http://127.0.0.1:8064/
Listens on 127.0.0.1 only.

API
  GET  /api/chargen               C64 character ROM (from the VICE folder)
  GET  /api/games                 list of game/*.json
  GET  /api/game?name=N           load game/N.json
  POST /api/game?name=N           save (the old file goes to game/backups/)
  POST /api/build?name=N[&run=1]  pack + compile (+ start VICE); returns the log
  POST /api/validate?name=N       pack only; returns warnings / the error
"""
import json, os, re, shutil, subprocess, sys, time
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
GAMES = os.path.join(ROOT, 'game')
STATIC = {'/': (HERE, 'index.html', 'text/html'),
          '/editor.js': (HERE, 'editor.js', 'text/javascript'),
          '/editor.css': (HERE, 'editor.css', 'text/css'),
          '/player': (os.path.join(ROOT, 'player'), 'index.html', 'text/html'),
          '/player/': (os.path.join(ROOT, 'player'), 'index.html', 'text/html'),
          '/player/player.js': (os.path.join(ROOT, 'player'), 'player.js', 'text/javascript'),
          '/player/player.css': (os.path.join(ROOT, 'player'), 'player.css', 'text/css')}
sys.path.insert(0, os.path.join(ROOT, 'tools'))
from pack import Packer, PackError
from toolchain import chargen, x64sc


def game_path(name):
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,40}', name or ''):
        raise ValueError('bad game name')
    return os.path.join(GAMES, name + '.json')


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def send(self, code, body, ctype='application/json'):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        try:
            if u.path in STATIC:
                directory, fn, ctype = STATIC[u.path]
                self.send(200, open(os.path.join(directory, fn), 'rb').read(), ctype + '; charset=utf-8')
            elif u.path == '/api/chargen':
                self.send(200, open(chargen(), 'rb').read(), 'application/octet-stream')
            elif u.path == '/api/games':
                names = sorted(f[:-5] for f in os.listdir(GAMES) if f.endswith('.json'))
                self.send(200, names)
            elif u.path == '/api/game':
                self.send(200, open(game_path(q['name'][0]), 'rb').read())
            else:
                self.send(404, {'error': 'not found'})
        except Exception as e:
            self.send(400, {'error': str(e)})

    def do_POST(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        try:
            name = q['name'][0]
            path = game_path(name)
            if u.path == '/api/game':
                data = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                if os.path.exists(path):
                    os.makedirs(os.path.join(GAMES, 'backups'), exist_ok=True)
                    shutil.copy(path, os.path.join(GAMES, 'backups', f'{name}-{time.strftime("%Y%m%d-%H%M%S")}.json'))
                with open(path, 'w', encoding='utf8') as f:
                    json.dump(data, f, indent=1)
                self.send(200, {'ok': True})
            elif u.path == '/api/validate':
                p = Packer(json.load(open(path, encoding='utf8')))
                try:
                    blob = p.pack()
                    self.send(200, {'ok': True, 'size': len(blob), 'warnings': p.warnings})
                except PackError as e:
                    self.send(200, {'ok': False, 'error': str(e), 'warnings': p.warnings})
            elif u.path == '/api/build':
                r = subprocess.run([sys.executable, os.path.join(ROOT, 'build.py'), 'dev', path],
                                   capture_output=True, text=True, cwd=ROOT)
                ok = r.returncode == 0
                if ok and q.get('run', ['0'])[0] == '1':
                    # run a copy, so that the next build can overwrite the output while VICE runs
                    run = os.path.join(ROOT, 'build', f'run-{time.strftime("%H%M%S")}.prg')
                    shutil.copy(os.path.join(ROOT, 'out', 'advgui_vdev.prg'), run)
                    subprocess.Popen([x64sc(), '-controlport2device', '3',
                                      '-autostart', run])
                self.send(200, {'ok': ok, 'log': r.stdout + r.stderr})
            else:
                self.send(404, {'error': 'not found'})
        except Exception as e:
            self.send(400, {'error': str(e)})


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8064
    print(f'ADVGUI editor: http://127.0.0.1:{port}/')
    ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()
