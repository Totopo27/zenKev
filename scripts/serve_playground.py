import os
import json
import http.server
import socketserver
import urllib.request
import urllib.parse

PORT = 3000
DIRECTORY = r"D:\DocumentosDiscoD\Zen\zenKev"
KEV_ENDPOINT = "http://127.0.0.1:8080/choice"

class ProxyHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def do_POST(self):
        if self.path == "/api/predict":
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length)
            
            # Reenviar al modelo Kev-4B v6 en puerto 8080
            req = urllib.request.Request(
                KEV_ENDPOINT,
                data=body,
                headers={"Content-Type": "application/json"}
            )
            try:
                with urllib.request.urlopen(req, timeout=10) as resp:
                    data = resp.read()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(data)
            except Exception as e:
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode())
        else:
            self.send_response(404)
            self.end_headers()

if __name__ == "__main__":
    with socketserver.TCPServer(("", PORT), ProxyHandler) as httpd:
        print(f"[OK] Playground UI disponible en http://localhost:{PORT}/test-page.html")
        httpd.serve_forever()
