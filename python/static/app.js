/**
 * bdownload web interface logic.
 *
 * Talks to the Flask API (server.py): uploads CSV/JSON files, lets the user
 * pick a link column per file, starts a batch and polls for progress.
 *
 * @author Jollibe Dablo
 */
(function () {
  "use strict";

  var $ = function (selector) { return document.querySelector(selector); };

  var state = {
    files: [],          // {id, name, header, rows, column, override, badge, kind}
    overrides: ["Auto-detect", "YouTube", "Facebook", "Image"],
    running: false,
    logCount: 0,
    timer: null,
    outputDir: ""
  };

  /** Escape text before putting it into HTML. */
  function esc(value) {
    return String(value).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /** Call the JSON API and return the parsed answer. Throws an Error on failure. */
  async function api(path, options) {
    var response = await fetch(path, options);
    var data = {};
    try { data = await response.json(); } catch (e) { /* empty body */ }
    if (!response.ok) { throw new Error(data.error || "Request failed (" + response.status + ")"); }
    return data;
  }

  function postJson(path, body) {
    return api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  }

  /** Show or clear the red error line under the progress bar. */
  function showError(message) {
    var el = $("#errorText");
    el.textContent = message || "";
    el.hidden = !message;
  }

  // ------------------------------------------------------------ ffmpeg

  function renderFfmpeg(info) {
    $("#ffmpegDot").className = "dot " + (info.ffmpeg ? "ok" : "bad");
    $("#ffmpegText").textContent = info.ffmpeg ? "ffmpeg detected" : "ffmpeg not found";
    var notice = $("#ffmpegNotice");
    if (info.ffmpeg) {
      notice.hidden = true;
    } else {
      notice.hidden = false;
      notice.innerHTML = "ffmpeg is not installed, so downloads use a single-file format (lower resolution, always with sound). " +
        "For full quality install it with <code>" + esc(info.ffmpeg_hint) + "</code> and press Recheck.";
    }
  }

  async function loadInfo() {
    var info = await api("/api/info");
    state.overrides = info.override_options || state.overrides;
    renderFfmpeg(info);
    if (!$("#outputDir").value) { $("#outputDir").value = info.default_output; }
    if (!info.yt_dlp) { showError("yt-dlp is not installed. Run: bdownload --reset"); }
  }

  // ------------------------------------------------------------- files

  async function addFiles(fileList) {
    showError("");
    for (var i = 0; i < fileList.length; i++) {
      var form = new FormData();
      form.append("file", fileList[i]);
      try {
        var data = await api("/api/files", { method: "POST", body: form });
        var entry = {
          id: data.id, name: data.name, header: data.header, rows: data.rows,
          column: data.guess, override: "Auto-detect", badge: "", kind: "empty"
        };
        state.files.push(entry);
        await refreshBadge(entry);
      } catch (error) {
        showError(error.message);
      }
    }
    renderFiles();
  }

  async function refreshBadge(entry) {
    try {
      var data = await postJson("/api/detect", { file_id: entry.id, column: entry.column, override: entry.override });
      entry.badge = data.label;
      entry.kind = data.kind;
    } catch (e) {
      entry.badge = "Unknown";
      entry.kind = "other";
    }
  }

  function selectHtml(id, field, options, current) {
    var items = options.map(function (o) {
      return '<option value="' + esc(o) + '"' + (o === current ? " selected" : "") + ">" + esc(o) + "</option>";
    }).join("");
    return '<div class="select-wrap"><select class="select" data-id="' + esc(id) + '" data-field="' + field + '">' + items + "</select></div>";
  }

  function renderFiles() {
    var list = $("#fileList");
    $("#emptyFiles").hidden = state.files.length > 0;
    list.innerHTML = state.files.map(function (f) {
      return '<article class="file">' +
        '<div class="file-top"><div><div class="file-name">' + esc(f.name) + "</div>" +
        '<div class="file-meta"><span>' + f.rows + ' rows</span><span class="badge ' + esc(f.kind) + '">' + esc(f.badge) + "</span></div></div>" +
        '<button class="remove" type="button" data-remove="' + esc(f.id) + '" aria-label="Remove ' + esc(f.name) + '">' +
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>' +
        "<div><label>Link column</label>" + selectHtml(f.id, "column", f.header, f.column) + "</div>" +
        "<div><label>Download as</label>" + selectHtml(f.id, "override", state.overrides, f.override) + "</div>" +
        "</article>";
    }).join("");
  }

  function findFile(id) {
    return state.files.filter(function (f) { return f.id === id; })[0];
  }

  async function removeFile(id) {
    state.files = state.files.filter(function (f) { return f.id !== id; });
    renderFiles();
    try { await api("/api/files/" + encodeURIComponent(id), { method: "DELETE" }); } catch (e) { /* ignore */ }
  }

  async function clearFiles() {
    var ids = state.files.map(function (f) { return f.id; });
    state.files = [];
    renderFiles();
    for (var i = 0; i < ids.length; i++) {
      try { await api("/api/files/" + encodeURIComponent(ids[i]), { method: "DELETE" }); } catch (e) { /* ignore */ }
    }
  }

  // ----------------------------------------------------------- folders

  async function openFolderPicker() {
    $("#modal").hidden = false;
    await browse($("#outputDir").value.trim() || "");
  }

  async function browse(path) {
    try {
      var data = await api("/api/browse?path=" + encodeURIComponent(path));
      state.browsePath = data.path;
      $("#modalPath").textContent = data.path;
      var html = "";
      if (data.parent) { html += '<button class="folder up" type="button" data-path="' + esc(data.parent) + '">Up one level</button>'; }
      html += data.folders.map(function (name) {
        var full = data.path.replace(/[\\/]$/, "") + (data.path.indexOf("\\") > -1 ? "\\" : "/") + name;
        return '<button class="folder" type="button" data-path="' + esc(full) + '">' + esc(name) + "</button>";
      }).join("");
      $("#folders").innerHTML = html || '<p class="empty">No sub-folders here.</p>';
    } catch (error) {
      if (path) { return browse(""); }   // typed path does not exist: start from home
      $("#folders").innerHTML = '<p class="empty">' + esc(error.message) + "</p>";
    }
  }

  // ---------------------------------------------------------- download

  function setRunning(running) {
    state.running = running;
    $("#startBtn").disabled = running;
    $("#stopBtn").disabled = !running;
  }

  async function startDownload() {
    showError("");
    try {
      await postJson("/api/start", {
        output_dir: $("#outputDir").value.trim(),
        workers: Number($("#workers").value),
        files: state.files.map(function (f) { return { file_id: f.id, column: f.column, override: f.override }; })
      });
    } catch (error) {
      showError(error.message);
      return;
    }
    state.logCount = 0;
    $("#log").innerHTML = "";
    $("#openBtn").disabled = true;
    setRunning(true);
    poll();
  }

  function addLog(row) {
    var empty = $("#emptyLog");
    if (empty) { empty.remove(); }
    var el = document.createElement("div");
    el.className = "log-row " + row.status;
    el.innerHTML = "<time>" + esc(row.time) + "</time><i></i><span>" + esc(row.message) + "</span>";
    var log = $("#log");
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
  }

  async function poll() {
    clearTimeout(state.timer);
    try {
      var s = await api("/api/status?since=" + state.logCount);
      s.logs.forEach(addLog);
      state.logCount = s.log_count;
      $("#countOk").textContent = s.ok;
      $("#countFailed").textContent = s.failed;
      $("#countSkipped").textContent = s.skipped;
      var pct = s.total ? Math.round((s.completed / s.total) * 100) : 0;
      $("#barFill").style.width = pct + "%";
      $("#bar").setAttribute("aria-valuenow", pct);

      if (s.state === "running") {
        $("#statusText").textContent = s.completed + " of " + s.total;
        state.timer = setTimeout(poll, 700);
        return;
      }
      if (s.state === "done") {
        $("#statusText").textContent = "Finished";
        state.outputDir = s.output_dir;
        $("#openBtn").disabled = false;
        setRunning(false);
        return;
      }
      $("#statusText").textContent = "Idle";
      setRunning(false);
    } catch (error) {
      showError(error.message);
      state.timer = setTimeout(poll, 1500);
    }
  }

  // ------------------------------------------------------------ wiring

  function init() {
    var dropzone = $("#dropzone");
    var input = $("#fileInput");

    dropzone.addEventListener("click", function () { input.click(); });
    dropzone.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); }
    });
    input.addEventListener("change", function () { addFiles(input.files).then(function () { input.value = ""; }); });
    ["dragenter", "dragover"].forEach(function (name) {
      dropzone.addEventListener(name, function (e) { e.preventDefault(); dropzone.classList.add("over"); });
    });
    ["dragleave", "drop"].forEach(function (name) {
      dropzone.addEventListener(name, function (e) { e.preventDefault(); dropzone.classList.remove("over"); });
    });
    dropzone.addEventListener("drop", function (e) { addFiles(e.dataTransfer.files); });

    $("#fileList").addEventListener("change", async function (e) {
      var select = e.target.closest("select");
      if (!select) { return; }
      var entry = findFile(select.dataset.id);
      if (!entry) { return; }
      entry[select.dataset.field] = select.value;
      await refreshBadge(entry);
      renderFiles();
    });
    $("#fileList").addEventListener("click", function (e) {
      var button = e.target.closest("[data-remove]");
      if (button) { removeFile(button.dataset.remove); }
    });

    $("#clearFiles").addEventListener("click", clearFiles);
    $("#workers").addEventListener("input", function (e) { $("#workersValue").textContent = e.target.value; });
    $("#startBtn").addEventListener("click", startDownload);
    $("#stopBtn").addEventListener("click", function () { postJson("/api/stop").catch(function (e) { showError(e.message); }); });
    $("#openBtn").addEventListener("click", function () { postJson("/api/open-folder", { path: state.outputDir }).catch(function (e) { showError(e.message); }); });
    $("#clearLog").addEventListener("click", function () {
      $("#log").innerHTML = '<p class="empty" id="emptyLog">Activity appears here once a download starts.</p>';
    });

    $("#ffmpegRecheck").addEventListener("click", async function () {
      try {
        var data = await postJson("/api/ffmpeg/recheck");
        renderFfmpeg(data);
      } catch (e) { showError(e.message); }
    });

    $("#browseBtn").addEventListener("click", openFolderPicker);
    $("#folders").addEventListener("click", function (e) {
      var button = e.target.closest("[data-path]");
      if (button) { browse(button.dataset.path); }
    });
    $("#modalCancel").addEventListener("click", function () { $("#modal").hidden = true; });
    $("#modalUse").addEventListener("click", function () {
      if (state.browsePath) { $("#outputDir").value = state.browsePath; }
      $("#modal").hidden = true;
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { $("#modal").hidden = true; }
    });

    loadInfo().catch(function (e) { showError(e.message); });
    poll();   // picks up a batch that is already running if the page was reloaded
  }

  init();
})();
