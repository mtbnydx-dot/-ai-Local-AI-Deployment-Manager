#!/usr/bin/env python3
import argparse
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin
from urllib.request import Request, urlopen


HOP_BY_HOP_HEADERS = {
    "connection",
    "content-length",
    "host",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
}


def get_current_model():
    now = time.time()
    if ProxyHandler.model_id and now < ProxyHandler.model_cache_expires_at:
        return ProxyHandler.model_id

    target = urljoin(ProxyHandler.backend.rstrip("/") + "/", "v1/models")
    try:
        with urlopen(target, timeout=5) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
        models = payload.get("data", [])
        if models and isinstance(models[0], dict) and models[0].get("id"):
            ProxyHandler.model_id = models[0]["id"]
            ProxyHandler.model_cache_expires_at = now + ProxyHandler.model_cache_seconds
            return ProxyHandler.model_id
    except Exception as exc:
        sys.stderr.write(f"Failed to refresh vLLM model id: {exc}\n")

    return ProxyHandler.model_id


def merge_system(existing, extracted):
    text_parts = []
    block_parts = []

    def add_part(value):
        if not value:
            return
        if isinstance(value, str):
            text_parts.append(value)
        elif isinstance(value, list):
            for item in value:
                add_part(item)
        elif isinstance(value, dict) and value.get("type") == "text" and isinstance(value.get("text"), str):
            text_parts.append(value["text"])
        else:
            block_parts.append(value)

    if existing:
        add_part(existing)
    for part in extracted:
        add_part(part)

    if not text_parts and not block_parts:
        return existing
    if not block_parts:
        return "\n\n".join(text_parts)
    return [{"type": "text", "text": text} for text in text_parts] + block_parts


def normalize_anthropic_messages(body, model_id=None):
    if not isinstance(body, dict) or not isinstance(body.get("messages"), list):
        return body

    body = dict(body)
    if model_id:
        body["model"] = model_id

    system_parts = []
    messages = []
    changed = False

    for message in body["messages"]:
        if isinstance(message, dict) and message.get("role") == "system":
            changed = True
            content = message.get("content", "")
            if isinstance(content, list):
                system_parts.extend(content)
            else:
                system_parts.append(content)
        else:
            messages.append(message)

    if changed:
        body["messages"] = messages
        body["system"] = merge_system(body.get("system"), system_parts)
    return body


class ProxyHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    backend = "http://127.0.0.1:8000"
    upstream_timeout = 600
    model_id = None
    model_cache_seconds = 30
    model_cache_expires_at = 0

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.log_date_time_string(), fmt % args))

    def do_GET(self):
        self.forward()

    def do_POST(self):
        self.forward()

    def do_OPTIONS(self):
        self.forward()

    def forward(self):
        raw_body = self.rfile.read(int(self.headers.get("Content-Length", "0") or 0))
        body = raw_body

        request_path = self.path.split("?", 1)[0]
        if self.command in {"POST", "PUT", "PATCH"} and request_path == "/v1/messages" and raw_body:
            try:
                payload = json.loads(raw_body.decode("utf-8"))
                payload = normalize_anthropic_messages(payload, get_current_model())
                body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            except Exception as exc:
                self.send_error(400, f"Invalid JSON for proxy normalization: {exc}")
                return

        headers = {
            key: value
            for key, value in self.headers.items()
            if key.lower() not in HOP_BY_HOP_HEADERS
        }
        if body:
            headers["Content-Length"] = str(len(body))

        target = urljoin(self.backend.rstrip("/") + "/", self.path.lstrip("/"))
        req = Request(target, data=body if self.command != "GET" else None, headers=headers, method=self.command)

        try:
            with urlopen(req, timeout=self.upstream_timeout) as resp:
                if self.should_stream_response(resp, raw_body):
                    self.stream_response(resp)
                else:
                    self.send_buffered_response(resp.status, resp.reason, resp.headers, resp.read())
        except HTTPError as exc:
            error_body = exc.read()
            self.send_buffered_response(exc.code, exc.reason, exc.headers, error_body)
        except URLError as exc:
            msg = f"Backend unavailable: {exc}".encode("utf-8")
            self.send_response(502, "Bad Gateway")
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(msg)))
            self.end_headers()
            self.wfile.write(msg)

    def should_stream_response(self, resp, raw_body):
        content_type = (resp.headers.get("Content-Type") or "").lower()
        if "text/event-stream" in content_type:
            return True
        if self.command in {"POST", "PUT", "PATCH"} and raw_body:
            try:
                payload = json.loads(raw_body.decode("utf-8"))
                return payload.get("stream") is True
            except Exception:
                return False
        return False

    def copy_response_headers(self, headers, streamed=False):
        for key, value in headers.items():
            lower = key.lower()
            if lower not in HOP_BY_HOP_HEADERS and not (streamed and lower == "cache-control"):
                self.send_header(key, value)
        if streamed:
            self.send_header("Cache-Control", headers.get("Cache-Control") or "no-cache")
            self.send_header("X-Accel-Buffering", "no")
            self.close_connection = True

    def send_buffered_response(self, status, reason, headers, body):
        self.send_response(status, reason)
        self.copy_response_headers(headers, streamed=False)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def stream_response(self, resp, chunk_size=65536):
        self.send_response(resp.status, resp.reason)
        self.copy_response_headers(resp.headers, streamed=True)
        self.end_headers()
        read_chunk = getattr(resp, "read1", resp.read)
        try:
            while True:
                chunk = read_chunk(chunk_size)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            sys.stderr.write("Client disconnected during proxied stream.\n")


def main():
    parser = argparse.ArgumentParser(description="Normalize Claude Code Anthropic requests for vLLM.")
    parser.add_argument("--listen", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8001)
    parser.add_argument("--backend", default="http://127.0.0.1:8000")
    parser.add_argument("--upstream-timeout", type=float, default=600)
    parser.add_argument("--model-cache-seconds", type=int, default=30)
    args = parser.parse_args()

    ProxyHandler.backend = args.backend
    ProxyHandler.upstream_timeout = max(args.upstream_timeout, 1)
    ProxyHandler.model_cache_seconds = max(args.model_cache_seconds, 0)
    model_id = get_current_model()
    server = ThreadingHTTPServer((args.listen, args.port), ProxyHandler)
    print(
        f"Claude/vLLM proxy listening on http://{args.listen}:{args.port} -> {args.backend}"
        f" model={model_id or 'unknown'}",
        flush=True,
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
