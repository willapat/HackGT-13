"""Local web server for the two frontends: the account app (frontend/) and the 3D town (town/).

They load files from each other (the town uses frontend/shared for login; the app's character preview
uses town/lib/three and town/assets), so both are served from the repo root, same paths as on disk. Like the
Vercel deploy (vercel.json), the account app is also the site's root: http://localhost:8080/ serves
frontend/index.html and its app/, shared/ and lib/ folders, and /frontend/ redirects there. The 3D town is
http://localhost:8080/town/?town=<id>. Only those two folders are served, never .env or backend code.
Responses aren't cached, so a refresh always picks up edits.

    python3 serve.py [port]
"""

import http.server
import os
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
SERVED = ("/frontend/", "/town/")
AT_ROOT = ("/app/", "/shared/", "/lib/")  # the account app's folders, also served at the root (vercel.json rewrites)


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def allowed(self) -> bool:
        """Serve the account app at /, redirect old /frontend/ links there, refuse anything outside the two folders."""
        path, query = self.path.split("?", 1)[0], self.path[len(self.path.split("?", 1)[0]):]
        target = "/" if path in ("/frontend", "/frontend/", "/frontend/index.html") else "/town/" if path == "/town" else None
        if target:  # (a folder needs its trailing slash so the page's relative links resolve)
            self.send_response(302)
            self.send_header("Location", target + query)
            self.end_headers()
            return False
        if path in ("/", "/index.html") or path.startswith(AT_ROOT):
            self.path = "/frontend" + ("/index.html" if path in ("/", "/index.html") else path) + query
        # Check the file it would actually serve (after %-decoding and resolving ".."), not the raw URL
        real = os.path.realpath(self.translate_path(self.path))
        if not any(real == os.path.join(ROOT, d.strip("/")) or real.startswith(os.path.join(ROOT, d.strip("/")) + os.sep) for d in SERVED):
            self.send_error(404)
            return False
        return True

    def do_GET(self):
        if self.allowed():
            super().do_GET()

    def do_HEAD(self):
        if self.allowed():
            super().do_HEAD()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    print(f"Luma: http://localhost:{port}/  (3D town: /town/)")
    http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
