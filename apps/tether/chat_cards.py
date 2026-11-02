"""Session-scoped stdio MCP publisher. No network listener or third-party packages."""
import base64
import datetime
import ipaddress
import json
import math
import os
import re
import socket
import stat
import struct
import sys
import tempfile
import time
import urllib.parse
import urllib.request

MARKER = "TETHER_CARD_V1\n"
MAX_IMAGE = 5 * 1024 * 1024
MAX_JSON = 128 * 1024
FETCH_DEADLINE = 30


def text(value, name, limit=500, required=True):
    if value is None and not required:
        return None
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise ValueError(name + " must be nonempty text, at most " + str(limit) + " characters")
    return value


def number(value, name, low=None, high=None):
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(name + " must be a finite number")
    if (low is not None and value < low) or (high is not None and value > high):
        raise ValueError(name + " is out of range")
    return value


def stamp(value):
    value = text(value, "timestamp", 80)
    parsed = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("timestamps require a time-zone offset")
    return value


def public_host(url):
    """The card tool needs no permission, so it must not reach the host's own network."""
    host = urllib.parse.urlsplit(url).hostname
    if not host:
        raise ValueError("image URL has no host")
    try:
        addresses = {info[4][0] for info in socket.getaddrinfo(host, 443, proto=socket.IPPROTO_TCP)}
    except socket.gaierror as exc:
        raise ValueError("image host does not resolve") from exc
    for address in addresses:
        if not ipaddress.ip_address(address.split("%")[0]).is_global:
            raise ValueError("image URLs must point to a public host")


def fetch_image(source):
    public_host(source)

    class PublicHTTPSOnly(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            if urllib.parse.urlsplit(newurl).scheme != "https":
                raise ValueError("image redirects must use HTTPS")
            public_host(newurl)
            return super().redirect_request(req, fp, code, msg, headers, newurl)

    deadline = time.monotonic() + FETCH_DEADLINE
    chunks, size = [], 0
    with urllib.request.build_opener(PublicHTTPSOnly).open(source, timeout=10) as response:
        while size <= MAX_IMAGE:
            if time.monotonic() > deadline:
                raise ValueError("image download took too long")
            chunk = response.read(64 * 1024)
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
    return b"".join(chunks)


def image_roots():
    roots = {os.getcwd(), tempfile.gettempdir(), "/tmp"}
    # Hermes's home: set by the holder for Hermes's server, and present in Hermes's own processes.
    for extra in (os.environ.get("TETHER_CARD_IMAGE_ROOT"), os.environ.get("HERMES_HOME")):
        if extra:
            roots.add(os.path.expanduser(extra))
    return [os.path.realpath(root) for root in roots]


def read_image(source):
    """Only regular files under the session's folder or the temp folder, outside hidden folders."""
    path = os.path.realpath(os.path.expanduser(source))
    root = next((r for r in image_roots() if os.path.commonpath([r, path]) == r), None)
    if root is None:
        raise ValueError("local images must be in the chat's folder or the temp folder")
    if any(part.startswith(".") for part in os.path.relpath(path, root).split(os.sep)):
        raise ValueError("local images cannot come from hidden folders")
    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError("image source must be a regular file")
        with os.fdopen(fd, "rb", closefd=False) as handle:
            return handle.read(MAX_IMAGE + 1)
    finally:
        os.close(fd)


def import_image(source):
    source = text(source, "image source", 4096)
    if source.startswith("https://"):
        data = fetch_image(source)
    else:
        if "://" in source:
            raise ValueError("images require an HTTPS URL or a local file path")
        data = read_image(source)
    if not data or len(data) > MAX_IMAGE:
        raise ValueError("image must be between 1 byte and 5 MiB")
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        mime = "image/png"
        if len(data) < 24:
            raise ValueError("invalid PNG")
        width, height = struct.unpack(">II", data[16:24])
        if not width or not height or width * height > 40_000_000:
            raise ValueError("image exceeds 40 megapixels")
    elif data.startswith(b"\xff\xd8\xff"):
        mime = "image/jpeg"
    elif data.startswith((b"GIF87a", b"GIF89a")):
        mime = "image/gif"
    elif data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        mime = "image/webp"
    else:
        raise ValueError("supported images: PNG, JPEG, GIF, WebP")
    return {"type": "image", "mimeType": mime, "data": base64.b64encode(data).decode("ascii")}


def prepare(args):
    if not isinstance(args, dict) or len(json.dumps(args)) > MAX_JSON:
        raise ValueError("card arguments must be an object no larger than 128 KiB")
    kind = args.get("kind")
    if kind not in ("weather", "image", "docker"):
        raise ValueError("kind must be weather, image, or docker")
    revision = args.get("revision", 1)
    if type(revision) is not int or not 1 <= revision <= 2147483647:
        raise ValueError("revision must be a positive 32-bit integer")
    card = {"version": 1, "id": text(args.get("id"), "id", 128), "revision": revision,
            "kind": kind, "title": text(args.get("title"), "title", 200),
            "fallback": text(args.get("fallback"), "fallback", 4000),
            "fetchedAt": stamp(args.get("fetchedAt")),
            "source": text(args.get("source"), "source", 500)}
    payload = args.get("payload")
    if not isinstance(payload, dict):
        raise ValueError("payload must be an object")
    image = None
    if kind == "weather":
        unit = payload.get("unit", "C")
        if unit not in ("C", "F"):
            raise ValueError("unit must be C or F")
        from zoneinfo import ZoneInfo
        zone = text(payload.get("timeZone"), "timeZone", 100)
        ZoneInfo(zone)
        hours = payload.get("hourly", [])
        if not isinstance(hours, list) or len(hours) > 24:
            raise ValueError("hourly must contain at most 24 observations")
        payload = {"location": text(payload.get("location"), "location", 200),
                   "timeZone": zone, "unit": unit,
                   "temperature": number(payload.get("temperature"), "temperature"),
                   "feelsLike": number(payload.get("feelsLike"), "feelsLike"),
                   "conditions": text(payload.get("conditions"), "conditions", 200),
                   "hourly": [{"time": stamp(h.get("time")),
                               "temperature": number(h.get("temperature"), "hourly temperature"),
                               "conditions": text(h.get("conditions"), "hourly conditions", 200),
                               "precipitation": number(h.get("precipitation"), "precipitation", 0, 100)} for h in hours]}
    elif kind == "docker":
        containers = payload.get("containers")
        if not isinstance(containers, list) or len(containers) > 100:
            raise ValueError("containers must be a list of at most 100 containers")
        rows = []
        for c in containers:
            rows.append({"id": text(c.get("id"), "container id", 128),
                         "name": text(c.get("name"), "container name", 200),
                         "state": text(c.get("state"), "container state", 100),
                         "health": text(c.get("health"), "health", 100, False),
                         "cpuPercent": number(c.get("cpuPercent"), "CPU", 0),
                         "memoryBytes": number(c.get("memoryBytes"), "memory", 0),
                         "detail": text(c.get("detail"), "detail", 2000, False)})
        if len({r["id"] for r in rows}) != len(rows):
            raise ValueError("container ids must be unique")
        total = payload.get("total", len(rows))
        if type(total) is not int or total < len(rows) or total > 2147483647:
            raise ValueError("total must be an integer at least the number of listed containers")
        payload = {"host": text(payload.get("host"), "host", 200), "containers": rows, "total": total}
    else:
        payload = {"alt": text(payload.get("alt"), "alt", 1000),
                   "imageSource": text(payload.get("imageSource"), "imageSource", 4096)}
        image = import_image(payload["imageSource"])
        # Paths and expiring URLs are input only. The log carries the imported bytes.
        payload.pop("imageSource")
    card["payload"] = payload
    if kind == "weather":
        for hour in payload["hourly"]:
            hour["label"] = datetime.datetime.fromisoformat(hour["time"].replace("Z", "+00:00")).astimezone(ZoneInfo(zone)).strftime("%a %H:%M")
    return card, image


def find_card(value, depth=0):
    if depth > 6:
        return None
    if isinstance(value, str):
        if value.startswith(MARKER):
            return json.JSONDecoder().raw_decode(value[len(MARKER):])[0]
        try:
            return find_card(json.loads(value), depth + 1)
        except (ValueError, TypeError):
            return None
    if isinstance(value, list):
        return next((card for item in value if (card := find_card(item, depth + 1))), None)
    if isinstance(value, dict):
        return next((card for key in ("result", "content", "text", "rawOutput")
                     if key in value and (card := find_card(value[key], depth + 1))), None)
    return None


SCHEMA = {"type": "object", "required": ["id", "kind", "title", "fallback", "fetchedAt", "source", "payload"],
          "properties": {
              "id": {"type": "string", "description": "Unique card id; reuse with a higher revision to refresh in place."},
              "revision": {"type": "integer", "minimum": 1},
              "kind": {"type": "string", "enum": ["weather", "image", "docker"]},
              "title": {"type": "string"}, "fallback": {"type": "string", "description": "Readable summary for older clients and continued conversations."},
              "fetchedAt": {"type": "string", "description": "Actual observation time, ISO8601 with offset."},
              "source": {"type": "string", "description": "Data provider or tool used."},
              "payload": {"type": "object", "description":
                  'weather: {location, timeZone (IANA), unit (C/F), temperature?, feelsLike?, conditions, hourly:[{time (ISO8601), temperature?, conditions, precipitation? (0-100)}]}. '
                  'image: {alt, imageSource (HTTPS URL or readable local file path, PNG/JPEG/GIF/WebP <=5MiB)}. '
                  'docker: {host, total?, containers:[{id, name, state, health?, cpuPercent?, memoryBytes?, detail?}]}, at most 100 rows. '
                  'Omit unavailable metrics; never invent observations.'}}}


def oversized_id(prefix):
    match = re.search(r'"id"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+)', prefix)
    return json.loads(match.group(1)) if match else None


def serve(input_stream=sys.stdin, output_stream=sys.stdout):
    while True:
        request = None
        line = input_stream.readline(MAX_JSON + 1)
        if not line:
            return
        if len(line) > MAX_JSON:
            # Answer and skip the rest of the line: dying here would take the tool away for the session.
            ident = oversized_id(line)
            while line and not line.endswith("\n"):
                line = input_stream.readline(MAX_JSON + 1)
            if ident is not None:
                output_stream.write(json.dumps({"jsonrpc": "2.0", "id": ident, "result": {
                    "isError": True, "content": [{"type": "text", "text": "Card not published: the request exceeds 128 KiB"}]}}) + "\n")
                output_stream.flush()
            continue
        try:
            request = json.loads(line)
            if "id" not in request:
                continue
            method = request.get("method")
            if method == "initialize":
                result = {"protocolVersion": request.get("params", {}).get("protocolVersion", "2024-11-05"),
                          "capabilities": {"tools": {}}, "serverInfo": {"name": "tether-cards", "version": "1"},
                          "instructions": "Use tether_publish_card whenever weather, images, or Docker status makes an answer clearer. Fetch real data with your tools first. No need for the user to ask for a card. Keep surrounding prose useful."}
            elif method == "tools/list":
                result = {"tools": [{"name": "tether_publish_card", "description":
                    "Show a native weather, image, or Docker card in this Tether conversation. Choose it yourself when useful in an answer. "
                    "This tool only presents data: fetch weather, inspect Docker, or generate/retrieve images with your existing tools first. "
                    "Use explicit locations and Docker host identities. Refresh an existing id with a higher revision. "
                    "Docker action buttons send requests back to you; verify targets and respect your normal permissions.",
                    "inputSchema": SCHEMA, "annotations": {"readOnlyHint": True, "destructiveHint": False}}]}
            elif method == "tools/call":
                params = request.get("params", {})
                if params.get("name") != "tether_publish_card":
                    raise ValueError("unknown tool")
                card, image = prepare(params.get("arguments"))
                content = [{"type": "text", "text": MARKER + json.dumps(card, ensure_ascii=False, separators=(",", ":"))}]
                if image:
                    content.append(image)
                result = {"content": content}
            elif method == "ping":
                result = {}
            else:
                output_stream.write(json.dumps({"jsonrpc": "2.0", "id": request["id"], "error": {"code": -32601, "message": "Unknown method"}}) + "\n")
                output_stream.flush()
                continue
        except (ValueError, TypeError, KeyError, AttributeError, OSError) as exc:
            result = {"isError": True, "content": [{"type": "text", "text": "Card not published: " + str(exc)}]}
            if not isinstance(locals().get("request"), dict) or "id" not in request:
                continue
        output_stream.write(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}, ensure_ascii=False) + "\n")
        output_stream.flush()


if __name__ == "__main__":
    serve()
