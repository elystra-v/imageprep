"""Serve only the prepared static app on loopback. Images never reach this server."""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

root = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--port', type=int, default=4331)
args = parser.parse_args()
if not (root / 'dist/index.html').is_file():
    raise SystemExit('First run: python3 scripts/build.py')

class AppHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        super().end_headers()

    def list_directory(self, path):
        self.send_error(404)
        return None

server = ThreadingHTTPServer(('127.0.0.1', args.port), partial(AppHandler, directory=str(root / 'dist')))
print(f'ImagePrep: http://127.0.0.1:{args.port}/', flush=True)
try:
    server.serve_forever()
except KeyboardInterrupt:
    pass
finally:
    server.server_close()
