"""
massfetch web server
====================

A small Flask app that serves the massfetch web interface on your own computer
and exposes a JSON API to the download engine in core.py.

It listens on 127.0.0.1 only, so it cannot be reached from other devices.

Run it directly:
    python server.py --port 5757 --no-open

Normally you start it with the `massfetch` command, which sets up Python for you.

@author Jollibe Dablo (byApolloWorks)
"""

import argparse
import logging
import os
import socket
import threading
import uuid
import webbrowser

from flask import Flask, abort, jsonify, request, send_from_directory

import core

APP_VERSION = "1.0.0"
HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_PORT = 5757

app = Flask(__name__, static_folder=os.path.join(HERE, "static"), static_url_path="/static")
app.config["MAX_CONTENT_LENGTH"] = 50 * 1024 * 1024  # 50 MB per upload

# In-memory state. Everything is lost when the server stops.
FILES = {}          # file_id -> {"name", "header", "rows"}
STATE = {"job": None, "ffmpeg": core.find_ffmpeg(), "port": DEFAULT_PORT}


# ------------------------------------------------------------- safety check

@app.before_request
def only_local_hosts():
    """Reject requests whose Host header is not this computer (blocks DNS rebinding)."""
    host = (request.host or "").split(":")[0].lower()
    if host not in ("127.0.0.1", "localhost", "[::1]"):
        abort(403)


def _default_output_dir():
    """Return the default download folder (~/Downloads/massfetch)."""
    return os.path.join(os.path.expanduser("~"), "Downloads", "massfetch")


# ------------------------------------------------------------------- pages

@app.get("/")
def index():
    """Serve the web interface."""
    return send_from_directory(app.static_folder, "index.html")


@app.get("/api/info")
def info():
    """Return app version, ffmpeg status and the default output folder."""
    return jsonify(
        version=APP_VERSION,
        ffmpeg=bool(STATE["ffmpeg"]),
        ffmpeg_hint=core.ffmpeg_install_hint(),
        yt_dlp=core.yt_dlp is not None,
        default_output=_default_output_dir(),
        override_options=core.TYPE_OVERRIDE_OPTIONS,
    )


@app.post("/api/ffmpeg/recheck")
def recheck_ffmpeg():
    """Look for ffmpeg again (after the user installs it)."""
    STATE["ffmpeg"] = core.find_ffmpeg()
    return jsonify(ffmpeg=bool(STATE["ffmpeg"]), ffmpeg_hint=core.ffmpeg_install_hint())


# ------------------------------------------------------------------- files

@app.post("/api/files")
def upload_file():
    """
    Upload a CSV or JSON file.

    Returns the file id, its column names, the number of rows and the column
    that most likely holds the links.
    """
    upload = request.files.get("file")
    if upload is None or not upload.filename:
        return jsonify(error="No file received."), 400

    name = os.path.basename(upload.filename)
    ext = os.path.splitext(name)[1].lower()
    if ext not in (".csv", ".json", ".txt"):
        return jsonify(error=f"{name} is not a CSV, JSON or TXT file."), 400

    temp_path = os.path.join(HERE, f".upload_{uuid.uuid4().hex}{ext}")
    try:
        upload.save(temp_path)
        header, rows = core.read_table(temp_path)
    except Exception as error:
        return jsonify(error=f"Could not read {name}: {error}"), 400
    finally:
        if os.path.exists(temp_path):
            os.remove(temp_path)

    if not header:
        return jsonify(error=f"{name} has no usable rows."), 400

    file_id = uuid.uuid4().hex[:12]
    FILES[file_id] = {"name": name, "header": header, "rows": rows}
    guess = core.guess_link_column(header)
    return jsonify(id=file_id, name=name, header=header, rows=len(rows), guess=header[guess] if guess >= 0 else "")


@app.delete("/api/files/<file_id>")
def remove_file(file_id):
    """Forget an uploaded file."""
    FILES.pop(file_id, None)
    return jsonify(ok=True)


@app.post("/api/detect")
def detect():
    """Describe the links found in one column (YouTube, Facebook, Image, Mixed ...)."""
    body = request.get_json(silent=True) or {}
    entry = FILES.get(body.get("file_id"))
    if not entry:
        return jsonify(error="File not found."), 404
    column = body.get("column")
    index = entry["header"].index(column) if column in entry["header"] else -1
    label, kind = core.summarize_links(entry["rows"], index, body.get("override", "Auto-detect"))
    return jsonify(label=label, kind=kind)


# ---------------------------------------------------------------- folders

@app.get("/api/browse")
def browse():
    """List the sub-folders of a folder so the page can offer a folder picker."""
    path = request.args.get("path") or os.path.expanduser("~")
    path = os.path.abspath(os.path.expanduser(path))
    if not os.path.isdir(path):
        return jsonify(error="That folder does not exist."), 400
    try:
        names = sorted(
            (n for n in os.listdir(path) if not n.startswith(".") and os.path.isdir(os.path.join(path, n))),
            key=str.lower,
        )
    except PermissionError:
        return jsonify(error="No permission to open that folder."), 403
    parent = os.path.dirname(path)
    return jsonify(path=path, parent=parent if parent != path else None, folders=names)


@app.post("/api/open-folder")
def open_folder():
    """Open the output folder in the system file manager."""
    body = request.get_json(silent=True) or {}
    path = body.get("path", "")
    if os.path.isdir(path):
        core.open_in_file_manager(path)
        return jsonify(ok=True)
    return jsonify(error="Folder not found."), 404


# --------------------------------------------------------------- downloads

@app.post("/api/start")
def start():
    """
    Start a batch.

    JSON body:
        files: [{"file_id": str, "column": str, "override": str}, ...]
        output_dir: folder to save into
        workers: 1 to 8 parallel downloads
    """
    job = STATE["job"]
    if job is not None and job.state == "running":
        return jsonify(error="A download is already running."), 409

    body = request.get_json(silent=True) or {}
    output_dir = (body.get("output_dir") or "").strip()
    if not output_dir:
        return jsonify(error="Choose an output folder first."), 400
    selections = body.get("files") or []
    if not selections:
        return jsonify(error="Add at least one CSV or JSON file first."), 400

    items = []
    for selection in selections:
        entry = FILES.get(selection.get("file_id"))
        if not entry:
            continue
        column = selection.get("column")
        if column not in entry["header"]:
            return jsonify(error=f"Choose a link column for {entry['name']}."), 400
        override = selection.get("override", "Auto-detect")
        for url in core.extract_links(entry["rows"], entry["header"].index(column)):
            items.append((entry["name"], url, core.effective_kind(url, override)))

    if not items:
        return jsonify(error="No links were found in the selected columns."), 400

    job = core.DownloadJob(
        items,
        os.path.abspath(os.path.expanduser(output_dir)),
        workers=body.get("workers", 3),
        ffmpeg_path=STATE["ffmpeg"],
    )
    STATE["job"] = job
    job.start()
    return jsonify(total=len(items))


@app.get("/api/status")
def status():
    """Return progress and any new log lines (use ?since=<lines already received>)."""
    job = STATE["job"]
    if job is None:
        return jsonify(state="idle", total=0, completed=0, ok=0, failed=0, skipped=0, logs=[], log_count=0)
    return jsonify(job.snapshot(since=request.args.get("since", 0, type=int)))


@app.post("/api/stop")
def stop():
    """Stop starting new downloads."""
    job = STATE["job"]
    if job is not None and job.state == "running":
        job.stop()
    return jsonify(ok=True)


# ------------------------------------------------------------------- start

def _find_free_port(preferred):
    """Return preferred if it is free, otherwise the next free port (up to 20 tries)."""
    for port in range(preferred, preferred + 20):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            if sock.connect_ex(("127.0.0.1", port)) != 0:
                return port
    raise RuntimeError("No free port found. Try --port with another number.")


def main():
    """Parse command-line options, start the server and open the browser."""
    parser = argparse.ArgumentParser(description="massfetch web server")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="port to listen on (default 5757)")
    parser.add_argument("--no-open", action="store_true", help="do not open the browser automatically")
    args = parser.parse_args()

    port = _find_free_port(args.port)
    STATE["port"] = port
    url = f"http://127.0.0.1:{port}"

    logging.getLogger("werkzeug").setLevel(logging.ERROR)
    print(f"\n  massfetch {APP_VERSION} is running at {url}")
    print("  Press Ctrl+C to stop.\n", flush=True)

    if not args.no_open:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    app.run(host="127.0.0.1", port=port, threaded=True, debug=False, use_reloader=False)


if __name__ == "__main__":
    main()
