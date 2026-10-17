# massfetch

Bulk video and image downloader with a clean web interface that runs on your own computer.

Give it CSV or JSON files full of links. It downloads every YouTube video, Facebook video and image link for you and saves a report of what worked.

Made by Jollibe Dablo (byApolloWorks).

## What you need

- [Node.js](https://nodejs.org) 16 or newer
- [Python](https://www.python.org/downloads/) 3.9 or newer
- [ffmpeg](https://ffmpeg.org) (optional, but recommended for full quality video with sound)

## Install

```bash
npm install -g massfetch
```

## Use it

1. Open a terminal and run:

   ```bash
   massfetch
   ```

2. Your browser opens the app. The very first run takes about a minute while it sets itself up. After that it starts in a second.
3. Click **Add CSV or JSON files** and choose your files.
4. For each file, check the **Link column**. It is picked for you when the column is called link, url, video and so on.
5. Choose an **Output folder**.
6. Click **Start download**.

When it finishes, click **Open output folder**. Your files are sorted into `YouTube`, `Facebook` and `Images` folders, and a `download_report_...csv` file lists every link and whether it worked.

To stop the app, go back to the terminal and press `Ctrl+C`.

## Start it with one click

Create a desktop shortcut and an app menu entry (Start Menu on Windows, Applications on Mac, app menu on Linux):

```bash
massfetch --install-launcher
```

To remove them:

```bash
massfetch --uninstall-launcher
```

## Install ffmpeg (optional)

| System  | Command                   |
| ------- | ------------------------- |
| Mac     | `brew install ffmpeg`     |
| Windows | `winget install ffmpeg`   |
| Linux   | `sudo apt install ffmpeg` |

Without ffmpeg, videos still download with sound, but at a lower resolution.

## Commands

| Command                          | What it does                                      |
| -------------------------------- | ------------------------------------------------- |
| `massfetch`                      | Start the app and open the browser                |
| `massfetch --port 8080`          | Use a different port (default 5757)               |
| `massfetch --no-open`            | Start without opening the browser                 |
| `massfetch --update`             | Update yt-dlp, then start                         |
| `massfetch --doctor`             | Check that Python, packages and ffmpeg are fine   |
| `massfetch --reset`              | Delete the private Python setup so it is rebuilt  |
| `massfetch --install-launcher`   | Create the desktop shortcut and app menu entry    |
| `massfetch --uninstall-launcher` | Remove them                                       |

## Your link files

Any CSV or JSON file works. The file just needs one column (or key) that holds links.

```csv
title,link
First video,https://www.youtube.com/watch?v=abc123
Second video,https://www.facebook.com/reel/123456
A photo,https://example.com/photo.jpg
```

```json
[
  { "name": "First video", "link": "https://youtu.be/abc123" },
  { "name": "A photo", "link": "https://example.com/photo.jpg" }
]
```

Each file can use a different column. If a file mixes link types, leave **Download as** on Auto-detect. If you know every link is the same kind, pick YouTube, Facebook or Image to force it.

## Something went wrong?

- **Videos fail to download.** Run `massfetch --update`. Sites change often and a newer yt-dlp usually fixes it.
- **A Facebook video fails.** Only public posts work. Private posts need a login, which massfetch never uses.
- **"Python not found".** Install Python 3.9 or newer from python.org. If it is installed in an unusual place, set the `MASSFETCH_PYTHON` environment variable to its full path.
- **Linux says it cannot create the environment.** Run `sudo apt install python3-venv`.
- **The launcher stopped working after moving Node.** Run `massfetch --install-launcher` again.
- **Anything else.** Run `massfetch --doctor` and check what it reports.

## Good to know

- The app only listens on your own computer (`127.0.0.1`). Nobody else on your network can reach it.
- Your files and links never leave your computer, except for the downloads themselves.
- The page loads the Poppins font from Google Fonts. Offline, it falls back to your system font.
- Only download content you have the right to download.

## For developers

```
bin/massfetch.js      the command (finds Python, builds the private environment, starts the server)
lib/python.js         Python discovery and virtual environment setup
lib/launcher.js       desktop shortcut and app menu entry for each operating system
python/core.py        the download engine (no web code, usable on its own)
python/server.py      Flask server and JSON API
python/static/        the web interface (HTML, CSS, JavaScript)
```

Run the server directly while developing:

```bash
cd python
pip install -r requirements.txt
python server.py --port 5757
```

## License

MIT. See [LICENSE](LICENSE).
