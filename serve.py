"""Local web server for the two frontends: the account app (frontend/) and the 3D town (town/).

They load files from each other (the town uses frontend/shared for login; the app's character preview
uses town/lib/three and town/assets), so both are served from the repo root, same paths as on disk:
http://localhost:8080/frontend/ and http://localhost:8080/town/?town=<id>. Only those two folders are
served, never .env or backend code. Responses aren't cached, so a refresh always picks up edits.

    python3 serve.py [port]
"""

import http.server
import os
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
SERVED = ("/frontend/", "/town/")


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def allowed(self) -> bool:
        """Redirect / and bare folder names; refuse anything outside the two served folders."""
        path = self.path.split("?", 1)[0]
        target = "/frontend/" if path in ("/", "/index.html") else path + "/" if path in ("/frontend", "/town") else None
        if target:  # a folder needs its trailing slash so the page's relative links resolve
            self.send_response(302)
            self.send_header("Location", target + (self.path[len(path):] if path != "/" else ""))
            self.end_headers()
            return False
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
    print(f"Luma: http://localhost:{port}/frontend/  (3D town: /town/)")
    http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
