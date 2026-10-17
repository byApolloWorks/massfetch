"""
bdownload core
==============

Download engine used by the bdownload web interface. It contains no web or GUI
code, so it can also be imported and used on its own.

What it does:
  * Reads CSV and JSON files and finds the column that holds the links.
  * Classifies each link as YouTube, Facebook or Image.
  * Downloads YouTube and Facebook videos with yt-dlp.
  * Falls back to reading the public Facebook page source when yt-dlp fails
    (no login or cookies are ever used).
  * Downloads direct image links over plain HTTP.
  * Runs many downloads in parallel and writes a results report (CSV).

@author Jollibe Dablo
"""

import csv
import html
import json
import os
import platform
import re
import shutil
import subprocess
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from urllib.parse import parse_qs, unquote, urlparse, urlunparse

try:
    import yt_dlp
except ImportError:  # pragma: no cover - reported to the user by the server
    yt_dlp = None

try:
    import requests
except ImportError:  # pragma: no cover
    requests = None


# --------------------------------------------------------------- constants

LINK_HEADER_HINTS = ["link", "url", "video", "reel", "href", "post", "image", "img"]
IMAGE_EXTENSIONS = (".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tiff", ".svg")

TYPE_LABELS = {"youtube": "YouTube", "facebook": "Facebook", "image": "Image", "other": "Unsupported"}

# Options for the "Download as" choice. "Auto-detect" classifies each link on its
# own; the others force every link in a file to be treated as that kind.
TYPE_OVERRIDE_OPTIONS = ["Auto-detect", "YouTube", "Facebook", "Image"]
OVERRIDE_TO_KIND = {"YouTube": "youtube", "Facebook": "facebook", "Image": "image"}

FB_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
IMG_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"

# Patterns that expose a direct video URL inside the public Facebook page source.
FB_VIDEO_URL_PATTERNS = [
    r'"browser_native_hd_url":"(.*?)"',
    r'"browser_native_sd_url":"(.*?)"',
    r'"playable_url_quality_hd":"(.*?)"',
    r'"playable_url":"(.*?)"',
    r'hd_src:"(.*?)"',
    r'hd_src_no_ratelimit:"(.*?)"',
    r'sd_src:"(.*?)"',
    r'sd_src_no_ratelimit:"(.*?)"',
]

# mbasic.facebook.com wraps the CDN URL in a /video_redirect/?src=... link.
FB_MBASIC_REDIRECT_PATTERN = r'href="(/video_redirect/\?src=[^"]+)"'


# ------------------------------------------------------------ table reading

def _sniff_delimiter(sample):
    """Guess the CSV delimiter from a text sample. Defaults to a comma."""
    try:
        return csv.Sniffer().sniff(sample, delimiters=",;\t|").delimiter
    except Exception:
        return ","


def read_csv(path):
    """
    Read a CSV file.

    Tries several encodings (UTF-8 with BOM, UTF-8, Windows-1252, Latin-1) and
    detects the delimiter automatically.

    Returns:
        tuple: (header list, list of data rows)
    """
    last_error = None
    for encoding in ("utf-8-sig", "utf-8", "cp1252", "latin-1"):
        try:
            with open(path, "r", encoding=encoding, newline="") as handle:
                sample = handle.read(4096)
                handle.seek(0)
                delimiter = _sniff_delimiter(sample) if sample.strip() else ","
                rows = list(csv.reader(handle, delimiter=delimiter))
            if not rows:
                return [], []
            return rows[0], rows[1:]
        except (UnicodeDecodeError, csv.Error) as error:
            last_error = error
    raise RuntimeError(f"Could not read CSV: {last_error}")


def read_json(path):
    """
    Read a JSON file into a table.

    Accepts a top-level list of objects, or an object that contains a list of
    objects (for example {"data": [...]}). A single object becomes one row.
    Nested values are stored as JSON text.

    Returns:
        tuple: (header list, list of data rows)
    """
    with open(path, "r", encoding="utf-8-sig") as handle:
        data = json.load(handle)

    if isinstance(data, dict):
        candidate = None
        for value in data.values():
            if isinstance(value, list) and value and isinstance(value[0], dict):
                candidate = value
                break
        data = candidate if candidate is not None else [data]

    if not isinstance(data, list) or not data:
        return [], []

    header, seen = [], set()
    for item in data:
        if isinstance(item, dict):
            for key in item:
                if key not in seen:
                    seen.add(key)
                    header.append(key)

    rows = []
    for item in data:
        if not isinstance(item, dict):
            continue
        row = []
        for key in header:
            value = item.get(key, "")
            if isinstance(value, (dict, list)):
                value = json.dumps(value, ensure_ascii=False)
            row.append("" if value is None else str(value))
        rows.append(row)
    return header, rows


def read_table(path):
    """Read a .csv or .json file based on its extension. Returns (header, rows)."""
    if os.path.splitext(path)[1].lower() == ".json":
        return read_json(path)
    return read_csv(path)


def guess_link_column(header):
    """Return the index of the column most likely to hold links (0 if unsure, -1 if no header)."""
    for index, name in enumerate(header):
        lowered = (name or "").strip().lower()
        if any(hint in lowered for hint in LINK_HEADER_HINTS):
            return index
    return 0 if header else -1


# ---------------------------------------------------------- classification

def classify_url(url):
    """Classify a link as 'youtube', 'facebook', 'image' or 'other'."""
    lowered = url.lower()
    if "youtube.com" in lowered or "youtu.be" in lowered:
        return "youtube"
    if "facebook.com" in lowered or "fb.watch" in lowered:
        return "facebook"
    if urlparse(lowered).path.endswith(IMAGE_EXTENSIONS):
        return "image"
    return "other"


def effective_kind(url, override="Auto-detect"):
    """Return the download kind for a link, honouring a manual override choice."""
    return OVERRIDE_TO_KIND.get(override) or classify_url(url)


def extract_links(rows, column_index):
    """Return all non-empty cell values from one column."""
    links = []
    if column_index < 0:
        return links
    for row in rows:
        if column_index < len(row):
            value = (row[column_index] or "").strip()
            if value:
                links.append(value)
    return links


def summarize_links(rows, column_index, override="Auto-detect", sample_size=25):
    """
    Describe what kind of links a column holds.

    Returns:
        tuple: (label, kind) where kind is 'youtube', 'facebook', 'image',
        'mixed', 'other' or 'empty'.
    """
    if column_index < 0:
        return "No column", "empty"
    if override in OVERRIDE_TO_KIND:
        kind = OVERRIDE_TO_KIND[override]
        return f"{TYPE_LABELS[kind]} (forced)", kind

    kinds = {classify_url(link) for link in extract_links(rows, column_index)[:sample_size]}
    if not kinds:
        return "Empty", "empty"
    if len(kinds) > 1:
        return "Mixed", "mixed"
    kind = next(iter(kinds))
    return TYPE_LABELS[kind], kind


# ------------------------------------------------------------------ ffmpeg

def find_ffmpeg():
    """Find ffmpeg on PATH or in common install folders. Returns a path or None."""
    found = shutil.which("ffmpeg")
    if found:
        return found
    for candidate in ("/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"):
        if os.path.isfile(candidate):
            return candidate
    return None


def ffmpeg_install_hint():
    """Return the install command for ffmpeg on the current operating system."""
    system = platform.system()
    if system == "Darwin":
        return "brew install ffmpeg"
    if system == "Windows":
        return "winget install ffmpeg"
    return "sudo apt install ffmpeg"


def build_format_selector(ffmpeg_available):
    """
    Choose the yt-dlp format string.

    With ffmpeg: prefer H.264 video and AAC audio (works in QuickTime and every
    Mac app), merged into one MP4.
    Without ffmpeg: video and audio cannot be merged, so pick a single
    already-combined file. This may be lower resolution but always has sound.
    """
    if ffmpeg_available:
        return (
            "bestvideo[ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a][acodec^=mp4a]/"
            "bestvideo[ext=mp4]+bestaudio[ext=m4a]/"
            "bestvideo*+bestaudio/"
            "best[ext=mp4]/best"
        )
    return "best[ext=mp4][vcodec^=avc1]/best[ext=mp4]/best"


# ---------------------------------------------------------- facebook fallback

def sanitize_filename(name, max_len=120):
    """Make a string safe to use as a file name."""
    name = re.sub(r'[\\/*?:"<>|\n\r\t]', "_", name or "").strip()
    name = re.sub(r"\s+", " ", name)
    return (name or "facebook_video")[:max_len]


def _unescape_scraped_url(raw_url):
    """Undo the JSON/HTML escaping found around URLs in page source."""
    try:
        url = raw_url.encode("utf-8").decode("unicode_escape")
    except Exception:
        url = raw_url
    return html.unescape(url).replace("\\/", "/")


def _to_mbasic_url(url):
    """Rewrite a facebook.com or fb.watch URL to the lightweight mbasic host."""
    return urlunparse(urlparse(url)._replace(scheme="https", netloc="mbasic.facebook.com"))


def _fetch_page(url, headers):
    """Download a web page as text."""
    response = requests.get(url, headers=headers, timeout=25, allow_redirects=True)
    response.raise_for_status()
    return response.text


def _extract_title(page):
    """Read the page title from og:title or the <title> tag."""
    match = re.search(r'<meta property="og:title" content="(.*?)"', page)
    if match:
        return html.unescape(match.group(1))
    match = re.search(r"<title>(.*?)</title>", page, re.DOTALL)
    return html.unescape(match.group(1)).strip() if match else None


def _extract_standard_video_url(page):
    """Find a direct video URL in a normal Facebook page."""
    for pattern in FB_VIDEO_URL_PATTERNS:
        match = re.search(pattern, page)
        if match:
            return _unescape_scraped_url(match.group(1))
    return None


def _extract_mbasic_video_url(page):
    """Find a direct video URL in an mbasic.facebook.com page."""
    match = re.search(FB_MBASIC_REDIRECT_PATTERN, page)
    if not match:
        return None
    query = parse_qs(urlparse(html.unescape(match.group(1))).query)
    values = query.get("src")
    return unquote(values[0]) if values else None


def scrape_facebook_video_url(page_url):
    """
    Read the direct video URL from a public Facebook page (no login, no cookies).

    Tries the normal page first, then the lightweight mbasic page. Only works
    for posts that are public.

    Returns:
        tuple: (video_url, title). Both are None when nothing was found.
    """
    if requests is None:
        return None, None
    headers = {"User-Agent": FB_USER_AGENT, "Accept-Language": "en-US,en;q=0.9"}
    title = None

    try:
        page = _fetch_page(page_url, headers)
        title = _extract_title(page)
        video_url = _extract_standard_video_url(page)
        if video_url:
            return video_url, title
    except Exception:
        pass

    try:
        page = _fetch_page(_to_mbasic_url(page_url), headers)
        video_url = _extract_mbasic_video_url(page)
        if video_url:
            return video_url, (_extract_title(page) or title)
    except Exception:
        pass

    return None, title


# ---------------------------------------------------------- direct downloads

def download_direct_video(video_url, dest_path, referer):
    """Stream a direct video URL to disk (used by the Facebook fallback)."""
    if requests is None:
        raise RuntimeError("The 'requests' package is required for the Facebook fallback.")
    headers = {"User-Agent": FB_USER_AGENT, "Referer": referer}
    with requests.get(video_url, headers=headers, stream=True, timeout=60) as response:
        response.raise_for_status()
        os.makedirs(os.path.dirname(dest_path), exist_ok=True)
        with open(dest_path, "wb") as handle:
            for chunk in response.iter_content(chunk_size=256 * 1024):
                if chunk:
                    handle.write(chunk)


def download_image(url, dest_dir):
    """
    Download a direct image link into dest_dir.

    Strips query parameters from the file name, uses .jpg when the link has no
    extension, and never overwrites a file (adds _1, _2, ... instead).

    Returns:
        str: path of the saved file.
    """
    if requests is None:
        raise RuntimeError("The 'requests' package is required to download images.")
    response = requests.get(url, headers={"User-Agent": IMG_USER_AGENT}, stream=True, timeout=20)
    response.raise_for_status()

    filename = os.path.basename(unquote(urlparse(url).path))
    base, ext = os.path.splitext(filename)
    base = sanitize_filename(base or "image")
    ext = ext or ".jpg"

    os.makedirs(dest_dir, exist_ok=True)
    dest_path = os.path.join(dest_dir, base + ext)
    counter = 1
    while os.path.exists(dest_path):
        dest_path = os.path.join(dest_dir, f"{base}_{counter}{ext}")
        counter += 1

    with open(dest_path, "wb") as handle:
        for chunk in response.iter_content(chunk_size=8192):
            if chunk:
                handle.write(chunk)
    return dest_path


def open_in_file_manager(path):
    """Open a folder in Finder, Explorer or the default Linux file manager."""
    try:
        system = platform.system()
        if system == "Darwin":
            subprocess.run(["open", path], check=False)
        elif system == "Windows":
            os.startfile(path)  # type: ignore[attr-defined]
        else:
            subprocess.run(["xdg-open", path], check=False)
    except Exception:
        pass


# --------------------------------------------------------------- the job

class DownloadJob:
    """
    A batch of downloads that runs in the background.

    Create it with a list of (source_file, url, kind) items, call start(), then
    poll snapshot() to read progress and log lines. Call stop() to stop
    starting new downloads (downloads already running will finish).

    Args:
        items: list of (source_file_name, url, kind) tuples.
        output_dir: folder where files and the report are saved.
        workers: number of parallel downloads (1 to 8).
        ffmpeg_path: path to ffmpeg, or None if it is not installed.
    """

    def __init__(self, items, output_dir, workers=3, ffmpeg_path=None):
        self.items = items
        self.output_dir = output_dir
        self.workers = max(1, min(8, int(workers)))
        self.ffmpeg_path = ffmpeg_path
        self.state = "idle"  # idle, running, done
        self.completed = 0
        self.report_path = None
        self._logs = []
        self._results = []
        self._lock = threading.Lock()
        self._stop = threading.Event()

    # -- public API ------------------------------------------------------

    def start(self):
        """Start the batch in a background thread."""
        self.state = "running"
        threading.Thread(target=self._run, daemon=True).start()

    def stop(self):
        """Stop starting new downloads."""
        self._stop.set()
        self._log("Stop requested. Finishing downloads in progress.", "warn")

    def snapshot(self, since=0):
        """
        Return the current progress as a dict.

        Args:
            since: number of log lines the caller already has; only newer
                lines are returned in "logs".
        """
        with self._lock:
            results = self._results
            return {
                "state": self.state,
                "total": len(self.items),
                "completed": self.completed,
                "ok": sum(1 for r in results if r["status"] == "success"),
                "failed": sum(1 for r in results if r["status"] == "failed"),
                "skipped": sum(1 for r in results if r["status"].startswith("skipped")),
                "report": self.report_path,
                "output_dir": self.output_dir,
                "log_count": len(self._logs),
                "logs": self._logs[since:],
            }

    # -- internals -------------------------------------------------------

    def _log(self, message, status="info"):
        """Add a line to the activity log."""
        with self._lock:
            self._logs.append({"time": datetime.now().strftime("%H:%M:%S"), "status": status, "message": message})

    def _ytdlp(self, url, format_selector):
        """Download a video with yt-dlp and return the saved file path."""
        options = {
            "outtmpl": os.path.join(self.output_dir, "%(extractor_key)s", "%(title).150B [%(id)s].%(ext)s"),
            "format": format_selector,
            "merge_output_format": "mp4",
            "noplaylist": True,
            "quiet": True,
            "no_warnings": True,
            "ignoreerrors": True,
            "retries": 3,
            "postprocessor_args": {"default": ["-movflags", "+faststart"]},
        }
        if self.ffmpeg_path:
            options["ffmpeg_location"] = self.ffmpeg_path
        with yt_dlp.YoutubeDL(options) as ydl:
            info = ydl.extract_info(url, download=True)
            if not info:
                raise RuntimeError("yt-dlp returned no info (the video may need a login)")
            filename = ydl.prepare_filename(info)
            mp4_path = os.path.splitext(filename)[0] + ".mp4"
            return mp4_path if os.path.exists(mp4_path) else filename

    def _facebook_scrape(self, url):
        """Facebook fallback: read the video URL from the public page and save it."""
        video_url, title = scrape_facebook_video_url(url)
        if not video_url:
            raise RuntimeError("No direct video link found in the page (post may be private or need a login)")
        safe_title = sanitize_filename(title or "facebook_video")
        dest_dir = os.path.join(self.output_dir, "Facebook")
        dest_path = os.path.join(dest_dir, f"{safe_title}.mp4")
        counter = 1
        while os.path.exists(dest_path):
            dest_path = os.path.join(dest_dir, f"{safe_title} ({counter}).mp4")
            counter += 1
        download_direct_video(video_url, dest_path, referer=url)
        return dest_path

    def _download_one(self, source, url, kind, format_selector):
        """Download a single link and return a result dict."""
        def result(status, error="", file=""):
            return {"source_file": source, "url": url, "status": status, "file": file, "error": error}

        if self._stop.is_set():
            return result("skipped_stopped")
        if kind == "other":
            self._log(f"Skipped, not a YouTube, Facebook or image link: {url}", "warn")
            return result("skipped_unsupported")

        if kind == "image":
            try:
                path = download_image(url, os.path.join(self.output_dir, "Images"))
                self._log(f"Image saved: {url}", "ok")
                return result("success", file=path)
            except Exception as error:
                self._log(f"Image failed: {url} ({error})", "error")
                return result("failed", str(error))

        if yt_dlp is None:
            self._log("yt-dlp is not installed.", "error")
            return result("failed", "yt-dlp is not installed")

        if kind == "youtube":
            try:
                path = self._ytdlp(url, format_selector)
                self._log(f"YouTube saved: {url}", "ok")
                return result("success", file=path)
            except Exception as error:
                self._log(f"YouTube failed: {url} ({error})", "error")
                return result("failed", str(error))

        # Facebook: yt-dlp first, then the page-source fallback.
        try:
            path = self._ytdlp(url, format_selector)
            self._log(f"Facebook saved: {url}", "ok")
            return result("success", file=path)
        except Exception as first_error:
            self._log(f"Facebook: yt-dlp failed, trying the page-source fallback for {url}", "warn")
            try:
                path = self._facebook_scrape(url)
                self._log(f"Facebook saved with fallback: {url}", "ok")
                return result("success", file=path)
            except Exception as second_error:
                self._log(f"Facebook failed: {url} ({second_error})", "error")
                return result("failed", f"yt-dlp: {first_error} | fallback: {second_error}")

    def _run(self):
        """Run every download, then write the report."""
        try:
            os.makedirs(self.output_dir, exist_ok=True)
            format_selector = build_format_selector(self.ffmpeg_path is not None)
            if not self.ffmpeg_path:
                self._log("ffmpeg not found. Using single-file downloads (lower resolution, always with sound).", "warn")

            with ThreadPoolExecutor(max_workers=self.workers) as pool:
                futures = {pool.submit(self._download_one, s, u, k, format_selector): (s, u) for s, u, k in self.items}
                for future in as_completed(futures):
                    try:
                        outcome = future.result()
                    except Exception as error:
                        source, url = futures[future]
                        outcome = {"source_file": source, "url": url, "status": "failed", "file": "", "error": str(error)}
                        self._log(f"Failed: {url} ({error})", "error")
                    with self._lock:
                        self._results.append(outcome)
                        self.completed += 1

            self.report_path = self._write_report()
            snap = self.snapshot()
            self._log(
                f"Done. {snap['ok']} succeeded, {snap['failed']} failed, {snap['skipped']} skipped.",
                "ok",
            )
        except Exception as error:
            self._log(f"Batch stopped by an unexpected error: {error}", "error")
        finally:
            self.state = "done"

    def _write_report(self):
        """Write download_report_<time>.csv into the output folder and return its path."""
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        path = os.path.join(self.output_dir, f"download_report_{stamp}.csv")
        fields = ["source_file", "url", "status", "file", "error"]
        with open(path, "w", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=fields)
            writer.writeheader()
            for row in self._results:
                writer.writerow({key: row.get(key, "") for key in fields})
        return path
