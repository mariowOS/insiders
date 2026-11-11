/*
mariowOS Terminal - more commands - (C) 2026 mariowstech and the mariowOS team
Licensed under the Apache License, Version 2.0.

Loaded after the Terminal's main script: it adds commands to the same COMMANDS table
(so help, Tab completion and suggestions know them) and uses its helpers (printLine,
readStdin, readHomeFile, requireAuth, promptInput...). Text commands read the files they
are given, or what is piped into them, so they combine: ls | grep mwex | sort -r
*/
(function () {
  "use strict";

  // ------------------------------------------------------------------ helpers
  // Short options (-abc, -n 5, -n5), long options (--lines=5 / --lines 5) and "--".
  function getopt(args, { flags = "", values = "", long = {} } = {}) {
    const opts = {};
    const rest = [];
    for (let k = 1; k < args.length; k++) {
      const arg = args[k];
      if (arg === "--") { rest.push(...args.slice(k + 1)); break; }
      if (arg.startsWith("--") && arg.length > 2) {
        const eq = arg.indexOf("=");
        const name = arg.slice(2, eq > 0 ? eq : undefined);
        const key = long[name];
        if (!key) throw new Error(mariowOSI18n.t("terminal.error.unknown-option", "unknown option '{option}'", { option: arg }));
        if (values.includes(key)) {
          const value = eq > 0 ? arg.slice(eq + 1) : args[++k];
          if (value === undefined) throw new Error(mariowOSI18n.t("terminal.error.option-needs-value", "option '{option}' requires an argument", { option: arg }));
          opts[key] = opts[key] === undefined ? value : [].concat(opts[key], value);
        } else opts[key] = true;
        continue;
      }
      if (arg.length > 1 && arg[0] === "-" && !/^-\d/.test(arg)) {
        for (let j = 1; j < arg.length; j++) {
          const c = arg[j];
          if (values.includes(c)) {
            const value = j + 1 < arg.length ? arg.slice(j + 1) : args[++k];
            if (value === undefined) throw new Error(mariowOSI18n.t("terminal.error.option-needs-value", "option '{option}' requires an argument", { option: `-${c}` }));
            opts[c] = opts[c] === undefined ? value : [].concat(opts[c], value);
            break;
          }
          if (!flags.includes(c)) throw new Error(mariowOSI18n.t("terminal.error.invalid-option", "invalid option -- '{option}'", { option: c }));
          opts[c] = true;
        }
        continue;
      }
      rest.push(arg);
    }
    return { opts, rest };
  }
  const list = value => value === undefined ? [] : [].concat(value);
  const toInt = (value, name) => {
    if (!/^[+-]?\d+$/.test(String(value))) throw new Error(mariowOSI18n.t("terminal.error.not-a-number", "{name}: '{value}' is not a number", { name, value }));
    return parseInt(value, 10);
  };
  const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const unescapeText = text => text.replace(/\\(n|t|r|\\|0|e)/g, (m, c) => ({ n: "\n", t: "\t", r: "\r", "\\": "\\", 0: "\0", e: "\x1b" })[c]);

  function printText(tab, text) {
    const lines = textLines(text);
    if (isCapturing(tab)) lines.forEach(line => printLine(tab, line));
    else if (lines.length) printLine(tab, lines.join("\n"));
  }
  function emit(tab, lines) {
    if (isCapturing(tab)) lines.forEach(line => printLine(tab, line));
    else if (lines.length) printLine(tab, lines.join("\n"));
  }

  // Waits, unless Ctrl+C comes first. Resolves true when the time ran out.
  function pause(tab, ms) {
    return new Promise(resolve => {
      if (tab.interrupted) return resolve(false);
      let off = () => {};
      const timer = setTimeout(() => { off(); resolve(true); }, ms);
      off = onInterrupt(tab, () => { clearTimeout(timer); resolve(false); });
    });
  }

  // Every file below a folder (find, grep -r), with a safety limit.
  async function walk(tab, root, visit, { maxDepth = 32, limit = 5000 } = {}) {
    let count = 0;
    const start = normalizeVirtualPath(root, tab.currentDirectory);
    const go = async (virtualPath, shown, depth) => {
      checkInterrupt(tab);
      let data;
      try { data = await getDirectoryContents(virtualPath); } catch (error) { return; }
      const items = data.contents.slice().sort((a, b) => a.name.localeCompare(b.name));
      for (const item of items) {
        if (++count > limit) throw new Error(mariowOSI18n.t("terminal.error.too-many-files", "stopped after {limit} entries", { limit }));
        const childPath = `${virtualPath === "/" ? "" : virtualPath}/${item.name}`;
        const childShown = shown === "." && root === "." ? `./${item.name}` : `${shown.replace(/\/$/, "")}/${item.name}`;
        await visit(item, childPath, childShown, depth + 1);
        if (item.type === "folder" && depth + 1 < maxDepth) await go(childPath, childShown, depth + 1);
      }
    };
    await go(start, root, 0);
  }

  // BRE (grep/sed default) to JavaScript: \( \) \{ \} \| \+ \? are the operators and
  // the bare characters are literal; -E switches to ERE, which JavaScript already speaks.
  function regexSource(pattern, extended) {
    if (extended) return pattern;
    let out = "";
    for (let i = 0; i < pattern.length; i++) {
      const c = pattern[i];
      if (c === "\\" && i + 1 < pattern.length) {
        const n = pattern[++i];
        out += "(){}|+?".includes(n) ? n : `\\${n}`;
      } else out += "(){}|+?".includes(c) ? `\\${c}` : c;
    }
    return out;
  }
  function makeRegExp(source, flags) {
    try { return new RegExp(source, flags); }
    catch (error) { throw new Error(mariowOSI18n.t("terminal.error.bad-regex", "invalid regular expression: {error}", { error: error.message.replace(/^Invalid regular expression: /, "") })); }
  }

  // Byte-oriented helpers for base64 / hashes (text is UTF-8).
  const utf8 = new TextEncoder();
  const toHex = buffer => [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, "0")).join("");

  // ----------------------------------------------------------- ANSI rendering
  // telnet / nc sessions: SGR colours and bold become spans; other escapes are dropped.
  const ANSI_COLORS = ["#4d4d4d", "#ff5f56", "#27c93f", "#ffbd2e", "#5c9dff", "#c864fa", "#5fd7d7", "#dddddd"];
  const ANSI_BRIGHT = ["#8a8a8a", "#ff8a80", "#69f0ae", "#ffe57f", "#92d9ff", "#ea80fc", "#84ffff", "#ffffff"];
  const ANSI_RE = /\x1b\[([0-9;?]*)([A-Za-z@`])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>78DEHMNOc]/g;
  const stripAnsi = text => text.replace(ANSI_RE, "");

  function createAnsiRenderer() {
    const state = { fg: null, bg: null, bold: false, underline: false };
    const applySgr = (params, st) => {
      const codes = params === "" ? [0] : params.split(";").map(n => parseInt(n, 10) || 0);
      for (let k = 0; k < codes.length; k++) {
        const code = codes[k];
        if (code === 0) Object.assign(st, { fg: null, bg: null, bold: false, underline: false });
        else if (code === 1) st.bold = true;
        else if (code === 4) st.underline = true;
        else if (code === 22) st.bold = false;
        else if (code === 24) st.underline = false;
        else if (code >= 30 && code <= 37) st.fg = (st.bold ? ANSI_BRIGHT : ANSI_COLORS)[code - 30];
        else if (code >= 90 && code <= 97) st.fg = ANSI_BRIGHT[code - 90];
        else if (code === 39) st.fg = null;
        else if (code >= 40 && code <= 47) st.bg = ANSI_COLORS[code - 40];
        else if (code >= 100 && code <= 107) st.bg = ANSI_BRIGHT[code - 100];
        else if (code === 49) st.bg = null;
        else if ((code === 38 || code === 48) && codes[k + 1] === 2) {
          const color = `rgb(${codes[k + 2] || 0}, ${codes[k + 3] || 0}, ${codes[k + 4] || 0})`;
          if (code === 38) st.fg = color; else st.bg = color;
          k += 4;
        } else if ((code === 38 || code === 48) && codes[k + 1] === 5) {
          const n = codes[k + 2] || 0;
          const color = n < 8 ? ANSI_COLORS[n] : n < 16 ? ANSI_BRIGHT[n - 8] : null;
          if (color) { if (code === 38) st.fg = color; else st.bg = color; }
          k += 2;
        }
      }
    };
    const render = (text, st) => {
      const fragment = document.createDocumentFragment();
      let last = 0;
      const pushText = chunk => {
        if (!chunk) return;
        const span = document.createElement("span");
        span.textContent = chunk;
        if (st.fg) span.style.color = st.fg;
        if (st.bg) span.style.background = st.bg;
        if (st.bold) span.style.fontWeight = "bold";
        if (st.underline) span.style.textDecoration = "underline";
        fragment.appendChild(span);
      };
      text.replace(ANSI_RE, (match, params, command, offset) => {
        pushText(text.slice(last, offset));
        last = offset + match.length;
        if (command === "m") applySgr(params, st);
        return match;
      });
      pushText(text.slice(last));
      return fragment;
    };
    return {
      line(text) {
        const div = document.createElement("div");
        div.style.whiteSpace = "pre-wrap";
        div.appendChild(render(text, state));
        if (!stripAnsi(text)) div.appendChild(document.createElement("br"));
        return div;
      },
      preview(text) { return render(text, { ...state }); }
    };
  }

  // ------------------------------------------------------------------- curl
  const CURL_HELP = "curl [options] <url>";
  // HTTP/2 responses carry no reason phrase; curl -i still shows the usual one.
  const REASONS = { 200: "OK", 201: "Created", 202: "Accepted", 204: "No Content", 206: "Partial Content", 301: "Moved Permanently", 302: "Found", 303: "See Other", 304: "Not Modified", 307: "Temporary Redirect", 308: "Permanent Redirect", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed", 409: "Conflict", 410: "Gone", 413: "Payload Too Large", 415: "Unsupported Media Type", 422: "Unprocessable Entity", 429: "Too Many Requests", 500: "Internal Server Error", 501: "Not Implemented", 502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout" };
  async function curlRequest(tab, options) {
    const controller = new AbortController();
    const off = onInterrupt(tab, () => controller.abort());
    const stop = options.spinner ? startSpinner(tab, options.spinner) : () => {};
    let response, data = {};
    try {
      response = await fetch("/api/terminal/http", {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
        body: JSON.stringify(options.request)
      });
      try { data = await response.json(); } catch (error) { data = { success: false, error: `HTTP ${response.status}` }; }
    } catch (error) {
      if (tab.interrupted) throw new MWShell.Interrupt();
      data = { success: false, code: 7, error: error.message };
    } finally {
      stop();
      off();
    }
    return data;
  }

  function curlUrl(raw) {
    let text = String(raw || "").trim();
    if (!text) return null;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`;
    try { return new URL(text); } catch (error) { return null; }
  }

  function remoteName(url) {
    const name = decodeURIComponent(url.pathname.split("/").pop() || "");
    return name && name !== "." && name !== ".." ? name.replace(/[\\/:*?"<>|]/g, "_") : "index.html";
  }

  function writeOut(format, data) {
    const values = {
      http_code: String(data.status || 0).padStart(3, "0"), response_code: String(data.status || 0),
      size_download: String(data.size || 0), time_total: (data.time || 0).toFixed(6),
      url_effective: data.url || "", content_type: data.contentType || "",
      redirect_url: ((data.headers || []).find(([key]) => key === "location") || [])[1] || ""
    };
    return unescapeText(format).replace(/%\{(\w+)\}/g, (match, name) => values[name] !== undefined ? values[name] : match);
  }

  async function runCurl(tab, args) {
    const { opts, rest } = getopt(args, {
      flags: "iILsSvfOGk",
      values: "XHdoAuemwbJU",
      long: {
        request: "X", header: "H", data: "d", "data-raw": "d", "data-binary": "d", "data-urlencode": "U", json: "J",
        include: "i", head: "I", location: "L", output: "o", "remote-name": "O", silent: "s", "show-error": "S",
        verbose: "v", fail: "f", "user-agent": "A", user: "u", referer: "e", "max-time": "m", "write-out": "w",
        cookie: "b", get: "G", insecure: "k"
      }
    });
    if (rest.length !== 1) throw usageError("curl");
    const url = curlUrl(rest[0]);
    if (!url) throw Object.assign(new Error("(3) URL rejected: Malformed input to a URL function"), { status: 3 });
    if (opts.k) printError(tab, "curl: -k is not supported: certificates are always verified");

    const headers = {};
    for (const header of list(opts.H)) {
      const colon = header.indexOf(":");
      if (colon < 1) throw new Error(mariowOSI18n.t("terminal.curl.bad-header", "bad header '{header}' (use \"Name: value\")", { header }));
      headers[header.slice(0, colon).trim()] = header.slice(colon + 1).trim();
    }
    if (opts.A) headers["User-Agent"] = opts.A;
    if (opts.e) headers.Referer = opts.e;
    if (opts.b) headers.Cookie = opts.b;
    if (opts.u) headers.Authorization = `Basic ${btoa(unescape(encodeURIComponent(opts.u)))}`;

    // -d DATA, -d @file (read from your home), --json DATA
    const readData = async value => value.startsWith("@") ? (await readHomeFile(tab, value.slice(1))).replace(/\r?\n/g, "") : value;
    const parts = [];
    for (const value of list(opts.d)) parts.push(await readData(value));
    for (const value of list(opts.U)) { const eq = value.indexOf("="); parts.push(eq >= 0 ? `${value.slice(0, eq + 1)}${encodeURIComponent(value.slice(eq + 1))}` : encodeURIComponent(value)); }
    let body;
    let method = opts.X ? String(opts.X).toUpperCase() : null;
    if (opts.J !== undefined) {
      body = await readData(list(opts.J).join(""));
      headers["Content-Type"] = headers["Content-Type"] || "application/json";
      headers.Accept = headers.Accept || "application/json";
    } else if (parts.length) {
      if (opts.G) url.search += (url.search ? "&" : "?") + parts.join("&");
      else {
        body = parts.join("&");
        if (!Object.keys(headers).some(key => key.toLowerCase() === "content-type")) headers["Content-Type"] = "application/x-www-form-urlencoded";
      }
    }
    if (!method) method = opts.I ? "HEAD" : body !== undefined ? "POST" : "GET";

    let saveTo = null;
    const discard = opts.o === "/dev/null";
    if (opts.o && opts.o !== "-" && !discard) saveTo = normalizeVirtualPath(opts.o, tab.currentDirectory);
    else if (opts.O) saveTo = normalizeVirtualPath(remoteName(url), tab.currentDirectory);

    if (opts.v) {
      printError(tab, `* Connecting to ${url.host}`);
      printError(tab, `> ${method} ${url.pathname}${url.search} HTTP/1.1`);
      printError(tab, `> Host: ${url.host}`);
      Object.entries(headers).forEach(([key, value]) => printError(tab, `> ${key}: ${key === "Authorization" ? "Basic ***" : value}`));
      printError(tab, ">");
    }

    const data = await curlRequest(tab, {
      spinner: !opts.s && (saveTo || opts.v) ? `${method} ${url.href}` : "",
      request: { url: url.href, method, headers, body, follow: !!opts.L, timeout: opts.m ? Number(opts.m) : 30, saveTo }
    });
    if (!data.success) {
      if (!opts.s || opts.S) printError(tab, `curl: (${data.code || 1}) ${data.error}`);
      return data.code || 1;
    }
    const statusLine = `HTTP/1.1 ${data.status} ${data.statusText || REASONS[data.status] || ""}`.trim();
    if (opts.v) {
      printError(tab, `< ${statusLine}`);
      data.headers.forEach(([key, value]) => printError(tab, `< ${key}: ${value}`));
      printError(tab, "<");
    }
    if (opts.f && data.status >= 400) {
      if (!opts.s || opts.S) printError(tab, `curl: (22) The requested URL returned error: ${data.status}`);
      return 22;
    }
    if (opts.i || opts.I) {
      emit(tab, [statusLine, ...data.headers.map(([key, value]) => `${key}: ${value}`), ""]);
    }
    if (!opts.I && !discard) {
      if (data.saved) {
        if (!opts.s) screenLine(tab, mariowOSI18n.t("terminal.curl.saved", "Saved {size} to {path} ({status}, {time} s)", { size: formatBytes(data.size), path: data.saved, status: data.status, time: data.time.toFixed(2) }), "color-gray");
      } else if (data.binary) {
        printError(tab, mariowOSI18n.t("terminal.curl.binary", "Warning: Binary output can mess up your terminal. Use \"-o <file>\" to save it to a file."));
        if (!opts.w) return 23;
      } else if (data.text) {
        printText(tab, data.text);
      }
    }
    if (opts.w) {
      const text = writeOut(opts.w, data);
      if (text) emit(tab, textLines(text.endsWith("\n") ? text : `${text}\n`));
    }
    if (!opts.L && data.status >= 300 && data.status < 400 && !opts.s && !opts.i && !opts.I && !isCapturing(tab)) {
      const location = (data.headers.find(([key]) => key === "location") || [])[1];
      if (location) screenLine(tab, mariowOSI18n.t("terminal.curl.redirect", "(redirected to {location} — add -L to follow it)", { location }), "color-gray");
    }
    return 0;
  }

  async function runWget(tab, args) {
    const { opts, rest } = getopt(args, { flags: "q", values: "OT", long: { "output-document": "O", quiet: "q", timeout: "T" } });
    if (rest.length !== 1) throw usageError("wget");
    const url = curlUrl(rest[0]);
    if (!url) throw new Error(`${rest[0]}: Invalid URL`);
    const toStdout = opts.O === "-";
    const fileName = opts.O && !toStdout ? opts.O : remoteName(url);
    const target = toStdout ? null : normalizeVirtualPath(fileName, tab.currentDirectory);
    if (!opts.q) screenLine(tab, `--${new Date().toISOString().replace("T", " ").slice(0, 19)}--  ${url.href}`, "color-gray");
    const data = await curlRequest(tab, {
      spinner: opts.q ? "" : mariowOSI18n.t("terminal.wget.downloading", "Downloading {name}...", { name: toStdout ? url.href : fileName }),
      request: { url: url.href, method: "GET", headers: {}, follow: true, timeout: opts.T ? Number(opts.T) : 60, saveTo: target }
    });
    if (!data.success) { printError(tab, `wget: ${data.error}`); return 4; }
    if (data.status >= 400) { printError(tab, `wget: ${data.status} ${data.statusText || ""} — ${url.href}`); return 8; }
    if (toStdout) { if (data.text) printText(tab, data.text); return 0; }
    if (!opts.q) {
      screenLine(tab, `HTTP request sent, awaiting response... ${data.status} ${data.statusText || ""}`, "color-gray");
      screenLine(tab, `'${data.saved}' saved [${data.size}]`, "color-green");
    }
    return 0;
  }

  // ------------------------------------------------------------ telnet / nc
  const SESSION_CLOSED = new Error("session closed");

  async function runSocket(tab, host, port, raw, { wait = 3 } = {}) {
    const name = raw ? "nc" : "telnet";
    const stdinText = readStdin(tab);
    const batch = stdinText !== null || isCapturing(tab);
    if (!batch) screenLine(tab, `Trying ${host}...`, "color-gray");
    let opened;
    try { opened = await api("/api/terminal/socket/open", { host, port, raw }); }
    catch (error) { throw new Error(raw ? `${host} ${port}: ${error.message}` : mariowOSI18n.t("terminal.telnet.unable", "Unable to connect to remote host: {error}", { error: error.message })); }
    const id = opened.id;
    const sendData = text => api(`/api/terminal/socket/${id}/send`, { data: text }).catch(() => {});
    const source = new EventSource(`/api/terminal/socket/${id}/stream`);
    const ansi = createAnsiRenderer();
    let partial = "";
    let serverEcho = false;
    let closed = false;
    let partialSpan = null;
    let idleTimer = null;
    let resolveDone;
    const done = new Promise(resolve => { resolveDone = resolve; });

    const flushLine = line => {
      if (batch) printLine(tab, stripAnsi(line));
      else insertBeforePrompt(tab, ansi.line(line));
    };
    const finish = message => {
      if (closed) return;
      closed = true;
      clearTimeout(idleTimer);
      source.close();
      api(`/api/terminal/socket/${id}/close`, {}).catch(() => {});
      if (partial) { flushLine(partial); partial = ""; }
      // A question still open for the next line: take it away.
      if (tab.inputRequest) {
        const request = tab.inputRequest;
        tab.inputRequest = null;
        tab.awaitingPassword = false;
        tab.busy = true;
        const line = tab.currentCursor && tab.currentCursor.parentElement;
        if (line) line.remove();
        tab.currentCursor = null;
        request.reject(SESSION_CLOSED);
      }
      if (message && !batch) screenLine(tab, message, "color-gray");
      resolveDone();
    };
    const armIdle = () => {
      if (!batch) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => finish(), wait * 1000);
    };

    source.addEventListener("data", event => {
      let payload = {};
      try { payload = JSON.parse(event.data); } catch (error) { return; }
      serverEcho = !!payload.echo;
      armIdle();
      if (!payload.text) return;
      let data = (partial + payload.text).replace(/\r\n|\n\r/g, "\n").replace(/\r/g, "").replace(/\x07|\x00/g, "");
      // Backspace erases the character before it.
      while (/[^\n\x08]\x08/.test(data)) data = data.replace(/[^\n\x08]\x08/, "");
      data = data.replace(/\x08/g, "");
      const lines = data.split("\n");
      partial = lines.pop();
      lines.forEach(flushLine);
      if (partialSpan) partialSpan.replaceChildren(ansi.preview(partial));
    });
    source.addEventListener("close", () => finish(mariowOSI18n.t("terminal.telnet.closed-remote", "Connection closed by foreign host.")));
    source.onerror = () => { if (source.readyState === EventSource.CLOSED) finish(mariowOSI18n.t("terminal.telnet.closed", "Connection closed.")); };
    const off = onInterrupt(tab, () => finish(mariowOSI18n.t("terminal.telnet.closed", "Connection closed.")));

    if (batch) {
      if (stdinText) await sendData(raw ? stdinText : stdinText.replace(/\r?\n/g, "\r\n"));
      armIdle();
      await done;
      off();
      return 0;
    }

    screenLine(tab, `Connected to ${host}.`, "color-gray");
    if (!raw) screenLine(tab, mariowOSI18n.t("terminal.telnet.escape", "Escape character is '^]'."), "color-gray");
    while (!closed) {
      const answer = promptInput(tab, `<span class="sock-partial"></span>`, { secret: serverEcho });
      const lineElement = tab.currentCursor && tab.currentCursor.parentElement;
      partialSpan = lineElement && lineElement.querySelector(".sock-partial");
      if (partialSpan) partialSpan.replaceChildren(ansi.preview(partial));
      let text;
      try { text = await answer; }
      catch (error) {
        if (error === SESSION_CLOSED) break;
        finish(mariowOSI18n.t("terminal.telnet.closed", "Connection closed."));
        break;
      }
      partialSpan = null;
      // With the server echoing, it sends the line back itself: drop ours.
      if (serverEcho) { if (lineElement) lineElement.remove(); }
      else partial = "";
      sendData(text + (raw ? "\n" : "\r\n"));
    }
    await done;
    off();
    return 0;
  }

  // --------------------------------------------------------------- store
  const TRUSTED_OWNERS = ["mariowos", "mariowstech"];
  const STORE_SUBCOMMANDS = {
    add: ["add <source> [--id ID] [--title TITLE] [--icon ICON]", mariowOSI18n.t("terminal.store.cmd.add", "Install an app from a GitHub repository, a raw .html URL, or a folder / .html file in your home (requires password)")],
    publish: ["publish <id> <github-url> [--title T] [--desc D] [--dev NAME] [--icon I]", mariowOSI18n.t("terminal.store.cmd.publish", "Add an app to the local Store catalog, so it appears in the Store and in 'get list'")],
    list: ["list", mariowOSI18n.t("terminal.store.cmd.list", "List the installed apps and where they came from")],
    info: ["info <id>", mariowOSI18n.t("terminal.store.cmd.info", "Show what the Store knows about an app")],
    remove: ["remove <id>", mariowOSI18n.t("terminal.store.cmd.remove", "Uninstall an app (requires password)")],
    open: ["open", mariowOSI18n.t("terminal.store.cmd.open", "Open the Store app")],
    help: ["help", mariowOSI18n.t("terminal.store.cmd.help", "Show this help")]
  };

  // GitHub links people copy from the browser, turned into what the kernel installs:
  // a repository clone (.git) or a single raw .html file.
  function resolveStoreSource(source) {
    let url;
    try { url = new URL(source); } catch (error) { return { error: mariowOSI18n.t("terminal.store.bad-url", "'{source}' is not a valid URL", { source }) }; }
    if (url.protocol !== "https:") return { error: mariowOSI18n.t("terminal.store.https-only", "only https:// sources can be installed") };
    const parts = url.pathname.split("/").filter(Boolean);
    if (url.hostname === "github.com" && parts.length >= 2) {
      const [owner, repoRaw] = parts;
      const repo = repoRaw.replace(/\.git$/, "");
      if (parts.length === 2) return { repoUrl: `https://github.com/${owner}/${repo}.git`, id: repo, owner, kind: "repo" };
      if (parts[2] === "blob" && parts.length >= 5 && /\.html?$/i.test(parts[parts.length - 1])) {
        return { repoUrl: `https://raw.githubusercontent.com/${owner}/${repo}/${parts.slice(3).join("/")}`, id: repo, owner, kind: "file" };
      }
      return { error: mariowOSI18n.t("terminal.store.github-shape", "use the repository address (https://github.com/owner/repo) or a link to a single .html file") };
    }
    if (url.hostname === "raw.githubusercontent.com" && parts.length >= 4) {
      if (!/\.html?$/i.test(parts[parts.length - 1])) return { error: mariowOSI18n.t("terminal.store.raw-html", "a raw file must be an .html page") };
      return { repoUrl: url.href, id: parts[1], owner: parts[0], kind: "file" };
    }
    return { error: mariowOSI18n.t("terminal.store.github-only", "only GitHub repositories and raw.githubusercontent.com files can be installed from the internet") };
  }
  const cleanAppId = value => String(value || "").replace(/\.html?$/i, "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

  function showStoreHelp(tab) {
    printHTML(tab, `<div>${mariowOSI18n.t("terminal.usage", "Usage: {syntax}", { syntax: `<span class="color-yellow">store</span> <span class="color-gray">&lt;command&gt;</span> [arguments]` })}</div>`);
    printTable(tab, mariowOSI18n.t("terminal.store.commands-title", "Store Commands:"), commandTableHeaders(), Object.values(STORE_SUBCOMMANDS));
    printLine(tab, mariowOSI18n.t("terminal.store.examples", "Examples:\n  store add https://github.com/someone/cool-app\n  store add ~/Projects/my-app --title \"My App\"      (a folder with an index.html)\n  store add page.html --id notes2\n  store publish my-app https://github.com/me/my-app --desc \"Does things\""), "color-gray");
  }

  async function storeAdd(tab, args) {
    const { opts, rest } = getopt(args, { values: "nti", long: { id: "n", title: "t", icon: "i" } });
    if (rest.length !== 1) throw new Error(mariowOSI18n.t("terminal.error.usage", "usage: {usage}", { usage: `store ${STORE_SUBCOMMANDS.add[0]}` }));
    const source = rest[0];
    let plan;
    if (/^https?:\/\//i.test(source)) {
      const resolved = resolveStoreSource(source);
      if (resolved.error) throw new Error(resolved.error);
      plan = { ...resolved, isolated: !TRUSTED_OWNERS.includes(String(resolved.owner).toLowerCase()) };
    } else {
      const virtualPath = normalizeVirtualPath(source, tab.currentDirectory);
      if (virtualPath !== "/home" && !virtualPath.startsWith("/home/")) throw new Error(mariowOSI18n.t("terminal.store.home-only", "local apps must be in your home partition"));
      const info = await statPath(virtualPath);
      if (!info) throw new Error(`${source}: ${mariowOSI18n.t("terminal.error.no-such-file-short", "No such file or directory")}`);
      if (info.type !== "folder" && !/\.html?$/i.test(virtualPath)) throw new Error(mariowOSI18n.t("terminal.store.local-shape", "choose a folder that has an index.html, or an .html file"));
      if (info.type === "folder") {
        const data = await getDirectoryContents(virtualPath);
        if (!data.contents.some(item => item.name === "index.html")) throw new Error(mariowOSI18n.t("terminal.store.no-index", "{path} has no index.html", { path: virtualPath }));
      }
      plan = { localPath: virtualPath, id: virtualPath.split("/").pop(), kind: info.type === "folder" ? "folder" : "file", isolated: true };
    }
    const appId = cleanAppId(opts.n || plan.id);
    if (!/^[A-Za-z0-9_-]+$/.test(appId)) throw new Error(mariowOSI18n.t("terminal.store.bad-id", "choose an app ID with --id (letters, digits, - and _)"));
    const title = opts.t || appId;
    const installed = await installedApps().catch(() => []);
    const already = installed.some(app => app.appId === appId);

    printLine(tab, mariowOSI18n.t("terminal.store.installing-from", "{action} '{id}' (\"{title}\") from {source}", {
      action: already ? mariowOSI18n.t("terminal.store.updating", "Updating") : mariowOSI18n.t("terminal.store.installing", "Installing"),
      id: appId, title, source: plan.localPath || plan.repoUrl
    }), "color-blue");
    if (plan.isolated) printLine(tab, mariowOSI18n.t("terminal.store.isolated", "  Third-party app: it runs isolated from the system, on its own origin."), "color-gray");
    await requireAuth(tab);

    if (plan.localPath) {
      const stop = startSpinner(tab, mariowOSI18n.t("terminal.store.copying", "Copying {path}...", { path: plan.localPath }));
      let result;
      try { result = await api("/api/store/sideload", { appId, title, icon: opts.i || "", path: plan.localPath }); }
      finally { stop(); }
      printLine(tab, `✔ ${mariowOSI18n.t("terminal.get.installed", "{pkg} installed successfully.", { pkg: appId })}`, "color-green");
      if (IS_EMBEDDED && !already) window.parent.postMessage({ type: "app-installed-live", app: { appId, title: result.app.title, icon: result.app.icon, url: result.app.url } }, window.location.origin);
    } else {
      await executeInstall({ id: appId, title, icon: opts.i || "📦", repoUrl: plan.repoUrl }, tab);
    }
    if (already) printLine(tab, mariowOSI18n.t("terminal.store.reopen", "Close and reopen the app to load the new version."), "color-gray");
    printLine(tab, mariowOSI18n.t("terminal.store.open-hint", "Open it with: open {id}", { id: appId.toLowerCase() }), "color-gray");
  }

  async function storePublish(tab, args) {
    const { opts, rest } = getopt(args, { values: "tdDi", long: { title: "t", desc: "d", description: "d", dev: "D", developer: "D", icon: "i" } });
    if (rest.length !== 2) throw new Error(mariowOSI18n.t("terminal.error.usage", "usage: {usage}", { usage: `store ${STORE_SUBCOMMANDS.publish[0]}` }));
    const [rawId, rawUrl] = rest;
    const id = cleanAppId(rawId);
    if (!id || id !== rawId) throw new Error(mariowOSI18n.t("terminal.store.bad-id", "choose an app ID with --id (letters, digits, - and _)"));
    const resolved = resolveStoreSource(rawUrl);
    if (resolved.error) throw new Error(resolved.error);
    // What the flags did not say is asked (Enter keeps the default in brackets).
    const ask = async (label, fallback) => {
      const answer = await promptInput(tab, `<span class="color-yellow">${escapeHtml(label)}</span> <span class="color-gray">[${escapeHtml(fallback)}]</span>&nbsp;`);
      return answer.trim() || fallback;
    };
    const title = opts.t || await ask(mariowOSI18n.t("terminal.store.ask-title", "Title:"), id);
    const desc = opts.d || await ask(mariowOSI18n.t("terminal.store.ask-desc", "Description:"), mariowOSI18n.t("terminal.store.default-desc", "An app for mariowOS"));
    const developer = opts.D || sysUsername;
    const result = await api("/api/store/publish", { id, title, developer, desc, repoUrl: resolved.repoUrl, icon: opts.i || "" });
    globalCatalog = [];
    printLine(tab, `✔ ${mariowOSI18n.t("terminal.store.published", "{id} added to the local Store catalog.", { id: result.app.id })}`, "color-green");
    printLine(tab, mariowOSI18n.t("terminal.store.published-hint", "Install it with 'get install {id}' or from the Store app.", { id: result.app.id }), "color-gray");
  }

  async function runStore(tab, args) {
    const sub = args[1];
    if (!sub || sub === "open") return openApp(tab, "store");
    if (sub === "help" || sub === "--help") { showStoreHelp(tab); return; }
    if (sub === "add" || sub === "install") return storeAdd(tab, args.slice(1));
    if (sub === "publish") return storePublish(tab, args.slice(1));
    if (sub === "list" || sub === "ls") {
      const installed = await installedApps();
      if (!installed.length) { printLine(tab, mariowOSI18n.t("terminal.store.none", "No apps installed from the Store yet. Try 'store add' or 'get list'.")); return; }
      printTable(tab, mariowOSI18n.t("terminal.store.installed-title", "Installed Apps:"),
        [mariowOSI18n.t("terminal.table.package-id", "package ID"), mariowOSI18n.t("terminal.table.title", "title"), mariowOSI18n.t("terminal.table.version", "version"), mariowOSI18n.t("terminal.table.source", "source")],
        installed.map(app => [app.appId, app.title || "", app.version || "", app.repoUrl || mariowOSI18n.t("terminal.store.system", "system")]));
      return;
    }
    if (sub === "info") {
      const id = args[2];
      if (!id) throw new Error(mariowOSI18n.t("terminal.error.usage", "usage: {usage}", { usage: "store info <id>" }));
      const [catalog, installed] = await Promise.all([loadCatalog().catch(() => []), installedApps().catch(() => [])]);
      const entry = catalog.find(app => app.id === id);
      const local = installed.find(app => app.appId === id);
      if (!entry && !local) {
        const suggestion = closestMatch(id, catalog.map(app => app.id).concat(installed.map(app => app.appId)));
        throw new Error(suggestion ? mariowOSI18n.t("terminal.get.not-found-suggest", "package '{pkg}' not found. Did you mean '{suggestion}'?", { pkg: id, suggestion }) : mariowOSI18n.t("terminal.get.not-found", "package '{pkg}' not found", { pkg: id }));
      }
      const rows = [
        [mariowOSI18n.t("terminal.store.field.id", "ID"), id],
        [mariowOSI18n.t("terminal.store.field.title", "Title"), (local && local.title) || (entry && entry.title) || ""],
        [mariowOSI18n.t("terminal.store.field.developer", "Developer"), (entry && entry.developer) || ""],
        [mariowOSI18n.t("terminal.store.field.description", "Description"), (entry && entry.desc) || ""],
        [mariowOSI18n.t("terminal.store.field.source", "Source"), (local && local.repoUrl) || (entry && entry.repoUrl) || ""],
        [mariowOSI18n.t("terminal.store.field.status", "Status"), local ? `${mariowOSI18n.t("terminal.table.installed", "installed")}${local.version ? ` (${local.version})` : ""}${local.isolated ? ` · ${mariowOSI18n.t("terminal.store.isolated-short", "isolated")}` : ""}` : mariowOSI18n.t("terminal.store.not-installed", "not installed")]
      ].filter(([, value]) => value);
      if (isCapturing(tab)) rows.forEach(([key, value]) => printLine(tab, `${key}: ${value}`));
      else printHTML(tab, rows.map(([key, value]) => `<span class="color-yellow">${escapeHtml(key.padEnd(12))}</span>${escapeHtml(value)}`).join("\n"));
      return;
    }
    if (sub === "remove" || sub === "uninstall") {
      const id = args[2];
      if (!id) throw new Error(mariowOSI18n.t("terminal.error.usage", "usage: {usage}", { usage: "store remove <id>" }));
      const installed = await installedApps();
      if (!installed.some(app => app.appId === id)) throw new Error(mariowOSI18n.t("terminal.get.not-installed", "package '{pkg}' is not installed", { pkg: id }));
      await requireAuth(tab);
      return removeInstalledApp(tab, id);
    }
    const suggestion = closestMatch(sub, Object.keys(STORE_SUBCOMMANDS));
    throw new Error(suggestion
      ? mariowOSI18n.t("terminal.store.invalid-suggest", "unknown command '{sub}'. Did you mean 'store {suggestion}'?", { sub, suggestion })
      : mariowOSI18n.t("terminal.store.invalid", "unknown command '{sub}'. Use 'store help'.", { sub }));
  }

  // ---------------------------------------------------------- desktop windows
  function desktopWindows() {
    if (!IS_EMBEDDED) return [];
    let doc;
    try { doc = window.parent.document; } catch (error) { return []; }
    return [...doc.querySelectorAll(".popup.active")].map(popup => {
      const label = popup.querySelector(".popup-header > span");
      const view = popup.ownerDocument.defaultView;
      const hidden = popup.style.display === "none" || popup.classList.contains("minimized") || view.getComputedStyle(popup).visibility === "hidden";
      return { id: popup.id, title: (label && label.textContent.trim()) || popup.id, state: hidden ? "minimized" : "open" };
    });
  }

  // ------------------------------------------------------------------- date
  function formatDate(date, format) {
    const pad = (n, w = 2) => String(n).padStart(w, "0");
    const locale = mariowOSI18n.locale || undefined;
    const map = {
      Y: date.getFullYear(), y: pad(date.getFullYear() % 100), m: pad(date.getMonth() + 1), d: pad(date.getDate()), e: String(date.getDate()).padStart(2, " "),
      H: pad(date.getHours()), I: pad(date.getHours() % 12 || 12), M: pad(date.getMinutes()), S: pad(date.getSeconds()), p: date.getHours() < 12 ? "AM" : "PM",
      s: Math.floor(date.getTime() / 1000), N: pad(date.getMilliseconds() * 1e6, 9), j: pad(Math.floor((date - new Date(date.getFullYear(), 0, 0)) / 864e5), 3),
      u: date.getDay() || 7, w: date.getDay(),
      A: date.toLocaleDateString(locale, { weekday: "long" }), a: date.toLocaleDateString(locale, { weekday: "short" }),
      B: date.toLocaleDateString(locale, { month: "long" }), b: date.toLocaleDateString(locale, { month: "short" }),
      Z: (Intl.DateTimeFormat(locale, { timeZoneName: "short" }).formatToParts(date).find(p => p.type === "timeZoneName") || {}).value || "",
      F: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`, T: `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
      D: `${pad(date.getMonth() + 1)}/${pad(date.getDate())}/${pad(date.getFullYear() % 100)}`, n: "\n", t: "\t", "%": "%"
    };
    return format.replace(/%([A-Za-z%])/g, (match, c) => map[c] !== undefined ? String(map[c]) : match);
  }

  // ------------------------------------------------------------------ printf
  function formatPrintf(format, values) {
    const fmt = unescapeText(format);
    let index = 0;
    let consumed = false;
    const one = () => fmt.replace(/%([-+ 0#]*)(\d+)?(?:\.(\d+))?([sdifxXoceg%])/g, (match, flags, width, precision, conv) => {
      if (conv === "%") return "%";
      consumed = true;
      const raw = values[index++];
      let out;
      switch (conv) {
        case "s": out = raw === undefined ? "" : String(raw); if (precision !== undefined) out = out.slice(0, +precision); break;
        case "c": out = raw === undefined ? "" : String(raw).charAt(0); break;
        case "d": case "i": out = String(Math.trunc(Number(raw) || 0)); break;
        case "f": out = (Number(raw) || 0).toFixed(precision === undefined ? 6 : +precision); break;
        case "e": out = (Number(raw) || 0).toExponential(precision === undefined ? 6 : +precision); break;
        case "g": out = String(Number(raw) || 0); break;
        case "x": out = (Math.trunc(Number(raw) || 0)).toString(16); break;
        case "X": out = (Math.trunc(Number(raw) || 0)).toString(16).toUpperCase(); break;
        case "o": out = (Math.trunc(Number(raw) || 0)).toString(8); break;
      }
      if (flags.includes("+") && /[dif]/.test(conv) && !out.startsWith("-")) out = `+${out}`;
      if (width && out.length < +width) {
        out = flags.includes("-") ? out.padEnd(+width) : flags.includes("0") && /[difxXo]/.test(conv) ? out.padStart(+width, "0") : out.padStart(+width);
      }
      return out;
    });
    let result = one();
    // Like the shell's printf, the format is reused until every argument is used.
    while (consumed && index < values.length) { consumed = false; result += one(); }
    return result;
  }

  // ------------------------------------------------------------------- cal
  function calendarLines(year, month, highlight) {
    const locale = mariowOSI18n.locale || undefined;
    const first = new Date(year, month, 1);
    const title = first.toLocaleDateString(locale, { month: "long", year: "numeric" });
    const days = new Date(year, month + 1, 0).getDate();
    // Weeks start on Monday, as in the rest of mariowOS.
    const weekdays = [...Array(7)].map((_, k) => new Date(2024, 0, 1 + k).toLocaleDateString(locale, { weekday: "short" }).slice(0, 2));
    const offset = (first.getDay() + 6) % 7;
    const cells = [...Array(offset).fill("  "), ...[...Array(days)].map((_, k) => String(k + 1).padStart(2))];
    const rows = [];
    for (let k = 0; k < cells.length; k += 7) rows.push(cells.slice(k, k + 7));
    return { title: title.padStart(Math.floor((20 + title.length) / 2)), header: weekdays.join(" "), rows, highlight };
  }

  // --------------------------------------------------------------- commands
  const BUILTIN_HELP = {
    sh: ["sh <script> [args...]", mariowOSI18n.t("terminal.cmd.sh", "Run a script (any text file); 'sh -c \"commands\"' runs a line")],
    source: ["source <file>", mariowOSI18n.t("terminal.cmd.source", "Run a script in this shell, so its variables, aliases and functions stay (also '.')")],
    export: ["export [NAME=value...]", mariowOSI18n.t("terminal.cmd.export", "Set variables (or list them all)")],
    unset: ["unset NAME...", mariowOSI18n.t("terminal.cmd.unset", "Remove variables (unset -f removes functions)")],
    env: ["env", mariowOSI18n.t("terminal.cmd.env", "List the variables")],
    set: ["set [-e] [-x] [-- args]", mariowOSI18n.t("terminal.cmd.set", "Shell options: -e stops a script at the first error, -x prints each command")],
    alias: ["alias [name='command']", mariowOSI18n.t("terminal.cmd.alias", "Define or list aliases (put them in ~/.mwshrc to keep them)")],
    unalias: ["unalias name", mariowOSI18n.t("terminal.cmd.unalias", "Remove an alias")],
    read: ["read [-p prompt] [-s] NAME...", mariowOSI18n.t("terminal.cmd.read", "Read a line from the user (or from a pipe) into variables; -s hides it")],
    test: ["test EXPR  /  [ EXPR ]", mariowOSI18n.t("terminal.cmd.test", "Check files (-f -d -e -s), text (= != -z -n) and numbers (-eq -lt -gt...)")],
    type: ["type NAME", mariowOSI18n.t("terminal.cmd.type", "Tell whether a name is a command, builtin, function, alias or script")],
    which: ["which NAME", mariowOSI18n.t("terminal.cmd.which", "Show where a command or script comes from")],
    true: ["true / false", mariowOSI18n.t("terminal.cmd.true", "Do nothing, successfully (true) or not (false)")],
    shift: ["shift [n]", mariowOSI18n.t("terminal.cmd.shift", "Drop the first script arguments ($1 becomes what $2 was)")],
    local: ["local NAME=value", mariowOSI18n.t("terminal.cmd.local", "A variable that only exists inside the current function")],
    return: ["return [status]", mariowOSI18n.t("terminal.cmd.return", "Leave the current function")],
    break: ["break / continue", mariowOSI18n.t("terminal.cmd.break", "Leave a loop, or go to its next round")],
    eval: ["eval <text>", mariowOSI18n.t("terminal.cmd.eval", "Run text as a command line")],
    time: ["time <command>", mariowOSI18n.t("terminal.cmd.time", "Run a command and say how long it took")],
    xargs: null
  };
  Object.entries(BUILTIN_HELP).forEach(([name, entry]) => {
    if (!entry) return;
    COMMANDS[name] = { group: "Shell", usage: entry[0], desc: entry[1], builtin: true, complete: ["sh", "source"].includes(name) ? "any" : undefined };
  });
  ["false", ".", "printenv", "continue", "run", "bash", "mwsh", "["].forEach(name => {
    COMMANDS[name] = { group: "Shell", usage: name, desc: "", builtin: true, hidden: true, complete: [".", "run", "bash", "mwsh"].includes(name) ? "any" : undefined };
  });

  const NEW_COMMANDS = {
    // --- general
    date: { group: "General", usage: "date [+FORMAT]", desc: mariowOSI18n.t("terminal.cmd.date", "Show the date and time; +FORMAT like +%Y-%m-%d %H:%M"),
      run: (tab, args) => {
        if (args[1] && args[1].startsWith("+")) { printLine(tab, formatDate(new Date(), args.slice(1).join(" ").slice(1))); return; }
        if (args.length > 1) throw usageError("date");
        printLine(tab, new Date().toString());
      } },
    sleep: { group: "General", usage: "sleep <seconds>", desc: mariowOSI18n.t("terminal.cmd.sleep", "Wait (2, 0.5, 1m, 2h); Ctrl+C stops it"),
      run: async (tab, args) => {
        const match = String(args[1] || "").match(/^(\d+(?:\.\d+)?)([smhd]?)$/);
        if (!match || args.length !== 2) throw usageError("sleep");
        const ms = parseFloat(match[1]) * ({ "": 1, s: 1, m: 60, h: 3600, d: 86400 })[match[2]] * 1000;
        if (!(await pause(tab, ms))) throw new MWShell.Interrupt();
      } },
    cal: { group: "General", usage: "cal [[month] year]", desc: mariowOSI18n.t("terminal.cmd.cal", "Show a month calendar"),
      run: (tab, args) => {
        const now = new Date();
        let year = now.getFullYear(), month = now.getMonth();
        if (args.length === 2) { year = toInt(args[1], "cal"); month = -1; }
        else if (args.length === 3) { month = toInt(args[1], "cal") - 1; year = toInt(args[2], "cal"); if (month < 0 || month > 11) throw new Error(mariowOSI18n.t("terminal.cal.bad-month", "{value} is not a month (1-12)", { value: args[1] })); }
        else if (args.length > 3) throw usageError("cal");
        const months = month === -1 ? [...Array(12).keys()] : [month];
        months.forEach((m, k) => {
          const cal = calendarLines(year, m);
          const today = now.getFullYear() === year && now.getMonth() === m ? now.getDate() : 0;
          if (k) printLine(tab, "");
          if (isCapturing(tab)) { [cal.title, cal.header, ...cal.rows.map(row => row.join(" "))].forEach(line => printLine(tab, line)); return; }
          const rows = cal.rows.map(row => row.map(cell => today && +cell === today ? `<span style="background:#fff;color:#000">${cell}</span>` : cell).join(" ")).join("\n");
          printHTML(tab, `<span class="color-blue">${escapeHtml(cal.title)}</span>\n<span class="color-gray">${escapeHtml(cal.header)}</span>\n${rows}`);
        });
      } },
    uuid: { group: "General", usage: "uuid", desc: mariowOSI18n.t("terminal.cmd.uuid", "Print a new random UUID"), run: tab => printLine(tab, crypto.randomUUID()) },
    random: { group: "General", usage: "random [max] | random <min> <max>", desc: mariowOSI18n.t("terminal.cmd.random", "Print a random whole number (1-100 by default)"),
      run: (tab, args) => {
        let min = 1, max = 100;
        if (args.length === 2) max = toInt(args[1], "random");
        else if (args.length === 3) { min = toInt(args[1], "random"); max = toInt(args[2], "random"); }
        else if (args.length > 3) throw usageError("random");
        if (max < min) [min, max] = [max, min];
        const range = max - min + 1;
        const buf = new Uint32Array(1);
        crypto.getRandomValues(buf);
        printLine(tab, String(min + (buf[0] % range)));
      } },
    man: { group: "General", usage: "man <command>", desc: mariowOSI18n.t("terminal.cmd.man", "Same as 'help <command>'"),
      complete: (tab, index) => index === 1 ? commandNames().concat(Object.keys(HELP_TOPICS)) : null,
      run: (tab, args) => { if (!args[1]) throw new Error(mariowOSI18n.t("terminal.man.which", "What manual page do you want? (e.g. man grep)")); showHelp(tab, args[1]); } },

    // --- files
    find: { group: "Files", usage: "find [dir] [-name PATTERN] [-iname P] [-type f|d] [-maxdepth N]", desc: mariowOSI18n.t("terminal.cmd.find", "Find files and folders below a folder by name or type"), complete: "dir",
      run: async (tab, args) => {
        const roots = [];
        let k = 1;
        while (k < args.length && !args[k].startsWith("-")) roots.push(args[k++]);
        let name = null, type = null, maxDepth = 32;
        for (; k < args.length; k++) {
          const a = args[k], v = args[k + 1];
          if ((a === "-name" || a === "-iname") && v !== undefined) { name = MWShell.globToRegExp(v); if (a === "-iname") name = new RegExp(name.source, "is"); k++; }
          else if (a === "-type" && (v === "f" || v === "d")) { type = v; k++; }
          else if (a === "-maxdepth" && v !== undefined) { maxDepth = toInt(v, "find"); k++; }
          else throw usageError("find");
        }
        for (const root of (roots.length ? roots : ["."])) {
          if (!(await statPath(normalizeVirtualPath(root, tab.currentDirectory)))) { printError(tab, `find: '${root}': ${mariowOSI18n.t("terminal.error.no-such-file-short", "No such file or directory")}`); continue; }
          if (!name && type !== "f") printLine(tab, root);
          await walk(tab, root, async (item, virtualPath, shown) => {
            if (type === "f" && item.type === "folder") return;
            if (type === "d" && item.type !== "folder") return;
            if (name && !name.test(item.name)) return;
            printLine(tab, shown);
          }, { maxDepth });
        }
      } },
    tree: { group: "Files", usage: "tree [dir] [-L depth] [-a]", desc: mariowOSI18n.t("terminal.cmd.tree", "Show folders and files as a tree"), complete: "dir",
      run: async (tab, args) => {
        const { opts, rest } = getopt(args, { flags: "ad", values: "L" });
        if (rest.length > 1) throw usageError("tree");
        const root = rest[0] || ".";
        const maxDepth = opts.L ? toInt(opts.L, "tree") : 32;
        const rootPath = normalizeVirtualPath(root, tab.currentDirectory);
        await getDirectoryContents(rootPath);
        const capture = isCapturing(tab);
        const lines = [capture ? root : `<span class="color-blue">${escapeHtml(root)}</span>`];
        let folders = 0, files = 0, count = 0;
        const go = async (virtualPath, prefix, depth) => {
          checkInterrupt(tab);
          const data = await getDirectoryContents(virtualPath);
          const items = data.contents.filter(item => (opts.a || !item.name.startsWith(".")) && (!opts.d || item.type === "folder")).sort((a, b) => a.name.localeCompare(b.name));
          for (let i = 0; i < items.length; i++) {
            if (++count > 5000) throw new Error(mariowOSI18n.t("terminal.error.too-many-files", "stopped after {limit} entries", { limit: 5000 }));
            const item = items[i];
            const last = i === items.length - 1;
            const name = item.type === "folder" ? (capture ? item.name : `<span class="color-blue">${escapeHtml(item.name)}</span>`) : (capture ? item.name : escapeHtml(item.name));
            lines.push(`${prefix}${last ? "└── " : "├── "}${name}`);
            if (item.type === "folder") {
              folders++;
              if (depth + 1 < maxDepth) await go(`${virtualPath === "/" ? "" : virtualPath}/${item.name}`, `${prefix}${last ? "    " : "│   "}`, depth + 1);
            } else files++;
          }
        };
        await go(rootPath, "", 0);
        const summary = mariowOSI18n.t("terminal.tree.summary", "{folders} directories, {files} files", { folders, files });
        if (capture) { lines.forEach(line => printLine(tab, line)); printLine(tab, ""); printLine(tab, summary); }
        else printHTML(tab, `${lines.join("\n")}\n\n<span class="color-gray">${escapeHtml(summary)}</span>`);
      } },
    stat: { group: "Files", usage: "stat <path>", desc: mariowOSI18n.t("terminal.cmd.stat", "Show the type, size and date of a file or folder"), complete: "any",
      run: async (tab, args) => {
        if (args.length < 2) throw usageError("stat");
        let status = 0;
        for (const target of args.slice(1)) {
          const virtualPath = normalizeVirtualPath(target, tab.currentDirectory);
          const info = await statPath(virtualPath);
          if (!info) { printError(tab, `stat: ${target}: ${mariowOSI18n.t("terminal.error.no-such-file-short", "No such file or directory")}`); status = 1; continue; }
          const rows = [["File", virtualPath], ["Type", info.type === "folder" ? "directory" : `file${info.ext ? ` (${info.ext})` : ""}`]];
          if (info.type !== "folder") rows.push(["Size", `${info.bytes >= 0 ? info.bytes : "--"} bytes${info.bytes >= 1024 ? ` (${formatBytes(info.bytes)})` : ""}`]);
          if (info.mtime) rows.push(["Modified", new Date(info.mtime).toLocaleString(mariowOSI18n.locale)]);
          else if (info.date) rows.push(["Modified", info.date]);
          rows.push(["Executable", /\.mwex$/i.test(virtualPath) ? "yes (.mwex)" : "no"]);
          emit(tab, rows.map(([key, value]) => `${key.padEnd(11)}${value}`));
        }
        return status;
      } },
    basename: { group: "Files", usage: "basename <path> [suffix]", desc: mariowOSI18n.t("terminal.cmd.basename", "Print the last part of a path (without the suffix)"),
      run: (tab, args) => {
        if (args.length < 2 || args.length > 3) throw usageError("basename");
        let base = args[1].replace(/\/+$/, "").split("/").pop() || "/";
        if (args[2] && base !== args[2] && base.endsWith(args[2])) base = base.slice(0, -args[2].length);
        printLine(tab, base);
      } },
    dirname: { group: "Files", usage: "dirname <path>", desc: mariowOSI18n.t("terminal.cmd.dirname", "Print a path without its last part"),
      run: (tab, args) => {
        if (args.length !== 2) throw usageError("dirname");
        const trimmed = args[1].replace(/\/+$/, "");
        const slash = trimmed.lastIndexOf("/");
        printLine(tab, slash < 0 ? "." : slash === 0 ? "/" : trimmed.slice(0, slash));
      } },
    realpath: { group: "Files", usage: "realpath <path>", desc: mariowOSI18n.t("terminal.cmd.realpath", "Print the full path"), complete: "any",
      run: (tab, args) => { if (args.length < 2) throw usageError("realpath"); args.slice(1).forEach(p => printLine(tab, normalizeVirtualPath(p, tab.currentDirectory))); } },

    // --- text
    grep: { group: "Text", usage: "grep [-ivnclowqFEr] <pattern> [file...]", desc: mariowOSI18n.t("terminal.cmd.grep", "Print the lines that match a pattern (-i any case, -v the others, -n line numbers, -c count, -r in folders)"), complete: "any",
      details: mariowOSI18n.t("terminal.cmd.grep-details", "  -i  ignore case        -v  lines that do NOT match   -n  line numbers\n  -c  count only         -l  only file names           -o  only the matching part\n  -w  whole words        -F  plain text, not a pattern -E  extended regex (| + ? ())\n  -r  search the files in folders (default: the current one)\n  -q  quiet: no output, only the exit status (for if and &&)\nExit status: 0 when something matched, 1 when nothing did."),
      run: async (tab, args) => {
        const { opts, rest } = getopt(args, { flags: "ivnclowFErRhHsq", values: "e", long: { quiet: "q", silent: "q", "ignore-case": "i", "invert-match": "v", "line-number": "n", count: "c", "files-with-matches": "l", "only-matching": "o", "word-regexp": "w", "fixed-strings": "F", "extended-regexp": "E", recursive: "r", regexp: "e" } });
        const pattern = opts.e !== undefined ? list(opts.e).join("|") : rest.shift();
        if (pattern === undefined) throw usageError("grep");
        let source = opts.F ? escapeRegExp(pattern) : regexSource(pattern, opts.E || opts.e !== undefined);
        if (opts.w) source = `(?<![\\w])(?:${source})(?![\\w])`;
        const re = makeRegExp(source, opts.i ? "gi" : "g");
        const recursive = opts.r || opts.R;
        const inputs = [];
        let status = 1, failed = false;
        if (recursive) {
          for (const root of (rest.length ? rest : ["."])) {
            const info = await statPath(normalizeVirtualPath(root, tab.currentDirectory));
            if (!info) { if (!opts.s) printError(tab, `grep: ${root}: ${mariowOSI18n.t("terminal.error.no-such-file-short", "No such file or directory")}`); failed = true; continue; }
            if (info.type !== "folder") { inputs.push({ name: root }); continue; }
            await walk(tab, root, async (item, virtualPath, shown) => { if (item.type !== "folder" && item.bytes <= 2 * 1048576) inputs.push({ name: shown, path: virtualPath }); });
          }
        } else if (!rest.length || (rest.length === 1 && rest[0] === "-")) {
          inputs.push({ name: "(standard input)", text: await inputText(tab, [], "grep") });
        } else rest.forEach(name => inputs.push({ name }));
        const showNames = opts.H || (!opts.h && (inputs.length > 1 || recursive));
        const capture = isCapturing(tab);
        for (const input of inputs) {
          checkInterrupt(tab);
          let text = input.text;
          if (text === undefined) {
            try { text = await readHomeFile(tab, input.path || input.name); }
            catch (error) { if (!recursive && !opts.s) printError(tab, `grep: ${error.message}`); if (!recursive) failed = true; continue; }
            if (recursive && text.includes("\0")) continue;
          }
          let count = 0;
          const out = [];
          textLines(text).forEach((line, index) => {
            re.lastIndex = 0;
            const hit = re.test(line);
            if (hit === !!opts.v) return;
            count++;
            if (opts.c || opts.l) return;
            const prefixText = `${showNames ? `${input.name}:` : ""}${opts.n ? `${index + 1}:` : ""}`;
            const prefixHtml = `${showNames ? `<span class="color-blue">${escapeHtml(input.name)}</span>:` : ""}${opts.n ? `<span class="color-green">${index + 1}</span>:` : ""}`;
            if (opts.o && !opts.v) {
              re.lastIndex = 0;
              for (const m of line.matchAll(re)) if (m[0]) out.push(capture ? prefixText + m[0] : `${prefixHtml}<span class="color-red">${escapeHtml(m[0])}</span>`);
            } else if (capture || opts.v) {
              out.push(capture ? prefixText + line : prefixHtml + escapeHtml(line));
            } else {
              re.lastIndex = 0;
              let html = "", last = 0;
              for (const m of line.matchAll(re)) {
                if (!m[0]) continue;
                html += escapeHtml(line.slice(last, m.index)) + `<span class="color-red">${escapeHtml(m[0])}</span>`;
                last = m.index + m[0].length;
              }
              out.push(prefixHtml + html + escapeHtml(line.slice(last)));
            }
          });
          if (count) status = 0;
          if (opts.q) { if (count) return 0; continue; }
          if (opts.l) { if (count) printLine(tab, input.name); continue; }
          if (opts.c) { printLine(tab, showNames ? `${input.name}:${count}` : String(count)); continue; }
          if (!out.length) continue;
          if (capture) out.forEach(line => printLine(tab, line));
          else printHTML(tab, out.join("\n"));
        }
        return status === 0 ? 0 : failed ? 2 : 1;
      } },
    head: { group: "Text", usage: "head [-n N] [file...]", desc: mariowOSI18n.t("terminal.cmd.head", "Print the first lines (10 by default)"), complete: "any",
      run: async (tab, args) => {
        const normalized = args.map(a => /^-\d+$/.test(a) ? `-n${a.slice(1)}` : a);
        const { opts, rest } = getopt(normalized, { flags: "qv", values: "nc", long: { lines: "n", bytes: "c" } });
        const n = opts.n !== undefined ? toInt(opts.n, "head") : 10;
        const files = rest.length ? rest : ["-"];
        for (let k = 0; k < files.length; k++) {
          const text = await inputText(tab, [files[k]], "head");
          if (files.length > 1) printLine(tab, `${k ? "\n" : ""}==> ${files[k]} <==`);
          if (opts.c !== undefined) { printLine(tab, text.slice(0, toInt(opts.c, "head"))); continue; }
          const lines = textLines(text);
          emit(tab, n >= 0 ? lines.slice(0, n) : lines.slice(0, n));
        }
      } },
    tail: { group: "Text", usage: "tail [-n N|+N] [file...]", desc: mariowOSI18n.t("terminal.cmd.tail", "Print the last lines (10 by default); -n +N starts at line N"), complete: "any",
      run: async (tab, args) => {
        const normalized = args.map(a => /^-\d+$/.test(a) ? `-n${a.slice(1)}` : a);
        const { opts, rest } = getopt(normalized, { flags: "qv", values: "nc", long: { lines: "n", bytes: "c" } });
        const spec = opts.n !== undefined ? String(opts.n) : "10";
        const files = rest.length ? rest : ["-"];
        for (let k = 0; k < files.length; k++) {
          const text = await inputText(tab, [files[k]], "tail");
          if (files.length > 1) printLine(tab, `${k ? "\n" : ""}==> ${files[k]} <==`);
          if (opts.c !== undefined) { printLine(tab, text.slice(-toInt(opts.c, "tail"))); continue; }
          const lines = textLines(text);
          emit(tab, spec.startsWith("+") ? lines.slice(toInt(spec.slice(1), "tail") - 1) : lines.slice(Math.max(0, lines.length - Math.abs(toInt(spec, "tail")))));
        }
      } },
    wc: { group: "Text", usage: "wc [-l] [-w] [-c] [file...]", desc: mariowOSI18n.t("terminal.cmd.wc", "Count lines, words and characters"), complete: "any",
      run: async (tab, args) => {
        const { opts, rest } = getopt(args, { flags: "lwcm", long: { lines: "l", words: "w", chars: "m", bytes: "c" } });
        const show = opts.l || opts.w || opts.c || opts.m ? opts : { l: true, w: true, c: true };
        const files = rest.length ? rest : ["-"];
        const total = [0, 0, 0];
        const row = (counts, name) => [show.l && counts[0], show.w && counts[1], (show.c || show.m) && counts[2]].filter(v => v !== false && v !== undefined).map(v => String(v).padStart(files.length > 1 || name ? 7 : 1)).join(" ") + (name ? ` ${name}` : "");
        for (const file of files) {
          const text = await inputText(tab, [file], "wc");
          const counts = [(text.match(/\n/g) || []).length, (text.match(/\S+/g) || []).length, opts.c ? utf8.encode(text).length : [...text].length];
          counts.forEach((v, k) => { total[k] += v; });
          printLine(tab, row(counts, file === "-" ? "" : file));
        }
        if (files.length > 1) printLine(tab, row(total, "total"));
      } },
    sort: { group: "Text", usage: "sort [-r] [-n] [-u] [-f] [-k N] [-t SEP] [file...]", desc: mariowOSI18n.t("terminal.cmd.sort", "Sort lines (-r reverse, -n by number, -u unique, -k by column)"), complete: "any",
      run: async (tab, args) => {
        const { opts, rest } = getopt(args, { flags: "rnufhV", values: "kto", long: { reverse: "r", "numeric-sort": "n", unique: "u", "ignore-case": "f", key: "k", "field-separator": "t", output: "o" } });
        let lines = textLines(await inputText(tab, rest, "sort"));
        const column = opts.k ? toInt(String(opts.k).split(",")[0].split(".")[0], "sort") : 0;
        const keyOf = line => {
          if (!column) return line;
          const fields = opts.t !== undefined ? line.split(opts.t) : line.trim().split(/\s+/);
          return fields.slice(column - 1).join(opts.t !== undefined ? opts.t : " ");
        };
        const collator = new Intl.Collator(mariowOSI18n.locale || undefined, { sensitivity: opts.f ? "base" : "variant", numeric: !!opts.V });
        lines.sort((a, b) => {
          const ka = keyOf(a), kb = keyOf(b);
          if (opts.n || opts.h) {
            const unit = s => { const m = String(s).trim().match(/^(-?\d*\.?\d+)\s*([KMGT]?)/i); return m ? parseFloat(m[1]) * (opts.h ? ({ "": 1, K: 1e3, M: 1e6, G: 1e9, T: 1e12 })[m[2].toUpperCase()] : 1) : 0; };
            return unit(ka) - unit(kb) || collator.compare(a, b);
          }
          return collator.compare(ka, kb);
        });
        if (opts.r) lines.reverse();
        if (opts.u) lines = lines.filter((line, k) => k === 0 || (opts.f ? line.toLowerCase() !== lines[k - 1].toLowerCase() : line !== lines[k - 1]));
        if (opts.o) { await writeHomeFile(tab, opts.o, lines.length ? lines.join("\n") + "\n" : ""); return; }
        emit(tab, lines);
      } },
    uniq: { group: "Text", usage: "uniq [-c] [-d] [-u] [-i] [file]", desc: mariowOSI18n.t("terminal.cmd.uniq", "Drop repeated neighbouring lines (-c counts them; sort first)"), complete: "any",
      run: async (tab, args) => {
        const { opts, rest } = getopt(args, { flags: "cdui", long: { count: "c", repeated: "d", unique: "u", "ignore-case": "i" } });
        const lines = textLines(await inputText(tab, rest, "uniq"));
        const groups = [];
        lines.forEach(line => {
          const last = groups[groups.length - 1];
          if (last && (opts.i ? last.line.toLowerCase() === line.toLowerCase() : last.line === line)) last.count++;
          else groups.push({ line, count: 1 });
        });
        emit(tab, groups.filter(g => (!opts.d || g.count > 1) && (!opts.u || g.count === 1)).map(g => opts.c ? `${String(g.count).padStart(7)} ${g.line}` : g.line));
      } },
    cut: { group: "Text", usage: "cut -d SEP -f LIST | -c LIST [file]", desc: mariowOSI18n.t("terminal.cmd.cut", "Keep some columns (-f 1,3 or 2-4, split by -d) or characters (-c)"), complete: "any",
      run: async (tab, args) => {
        const { opts, rest } = getopt(args, { flags: "s", values: "dfc", long: { delimiter: "d", fields: "f", characters: "c" } });
        if (!opts.f && !opts.c) throw usageError("cut");
        const ranges = String(opts.f || opts.c).split(",").map(part => {
          const m = part.match(/^(\d*)-(\d*)$/);
          if (m) return [m[1] ? +m[1] : 1, m[2] ? +m[2] : Infinity];
          if (!/^\d+$/.test(part)) throw usageError("cut");
          return [+part, +part];
        });
        const keep = n => ranges.some(([a, b]) => n >= a && n <= b);
        const delimiter = opts.d !== undefined ? unescapeText(opts.d) : "\t";
        const lines = textLines(await inputText(tab, rest, "cut"));
        emit(tab, lines.flatMap(line => {
          if (opts.c) return [[...line].filter((ch, k) => keep(k + 1)).join("")];
          if (!line.includes(delimiter)) return opts.s ? [] : [line];
          return [line.split(delimiter).filter((field, k) => keep(k + 1)).join(delimiter)];
        }));
      } },
    tr: { group: "Text", usage: "tr [-d] [-s] SET1 [SET2]", desc: mariowOSI18n.t("terminal.cmd.tr", "Replace or delete characters: tr a-z A-Z, tr -d '0-9'"),
      run: async (tab, args) => {
        const { opts, rest } = getopt(args, { flags: "dsc", long: { delete: "d", "squeeze-repeats": "s" } });
        if (!rest.length || rest.length > 2 || (!opts.d && !opts.s && rest.length !== 2)) throw usageError("tr");
        const CLASSES = { "[:upper:]": "A-Z", "[:lower:]": "a-z", "[:digit:]": "0-9", "[:alpha:]": "a-zA-Z", "[:alnum:]": "a-zA-Z0-9", "[:space:]": " \\t\\n\\r", "[:punct:]": "!-/:-@[-`{-~" };
        const expand = set => {
          let text = unescapeText(Object.entries(CLASSES).reduce((s, [k, v]) => s.split(k).join(v), set));
          const out = [];
          const chars = [...text];
          for (let k = 0; k < chars.length; k++) {
            if (chars[k + 1] === "-" && chars[k + 2] !== undefined) {
              const from = chars[k].codePointAt(0), to = chars[k + 2].codePointAt(0);
              for (let c = from; c <= to; c++) out.push(String.fromCodePoint(c));
              k += 2;
            } else out.push(chars[k]);
          }
          return out;
        };
        const set1 = expand(rest[0]);
        const set2 = rest[1] !== undefined ? expand(rest[1]) : [];
        const inSet1 = new Set(set1);
        let text = readStdin(tab);
        if (text === null) throw new Error(mariowOSI18n.t("terminal.tr.stdin", "tr reads what is piped into it, e.g. echo hello | tr a-z A-Z"));
        let out = "";
        let previous = null;
        for (const ch of text) {
          let next = ch;
          if (opts.d) { if (inSet1.has(ch)) continue; }
          else if (set2.length && inSet1.has(ch)) next = set2[Math.min(set1.indexOf(ch), set2.length - 1)];
          if (opts.s && next === previous && (set2.length ? set2.includes(next) : inSet1.has(next))) continue;
          out += next;
          previous = next;
        }
        printText(tab, out);
      } },
    rev: { group: "Text", usage: "rev [file...]", desc: mariowOSI18n.t("terminal.cmd.rev", "Reverse each line"), complete: "any",
      run: async (tab, args) => emit(tab, textLines(await inputText(tab, args.slice(1), "rev")).map(line => [...line].reverse().join(""))) },
    tee: { group: "Text", usage: "tee [-a] <file...>", desc: mariowOSI18n.t("terminal.cmd.tee", "Copy what is piped in to files and to the output (-a appends)"), complete: "any",
      run: async (tab, args) => {
        const { opts, rest } = getopt(args, { flags: "a", long: { append: "a" } });
        const text = readStdin(tab) || "";
        for (const file of rest) await writeHomeFile(tab, file, text, !!opts.a);
        printText(tab, text);
      } },
    seq: { group: "Text", usage: "seq [first [step]] last", desc: mariowOSI18n.t("terminal.cmd.seq", "Print a sequence of numbers"),
      run: (tab, args) => {
        const { opts, rest } = getopt(args, { flags: "w", values: "s", long: { separator: "s" } });
        const nums = rest.map(v => { const n = Number(v); if (!Number.isFinite(n)) throw usageError("seq"); return n; });
        if (!nums.length || nums.length > 3) throw usageError("seq");
        const [first, step, last] = nums.length === 1 ? [1, 1, nums[0]] : nums.length === 2 ? [nums[0], 1, nums[1]] : nums;
        if (step === 0) throw new Error(mariowOSI18n.t("terminal.seq.zero", "the step cannot be 0"));
        const values = [];
        for (let v = first; step > 0 ? v <= last + 1e-9 : v >= last - 1e-9; v += step) {
          if (values.length >= 100000) throw new Error(mariowOSI18n.t("terminal.seq.too-long", "too many numbers (100000 at most)"));
          values.push(Number.isInteger(step) && Number.isInteger(first) ? String(Math.round(v)) : String(+v.toFixed(10)));
        }
        const width = opts.w ? Math.max(...values.map(v => v.length)) : 0;
        const formatted = values.map(v => v.padStart(width, "0"));
        if (opts.s !== undefined) printLine(tab, formatted.join(unescapeText(opts.s)));
        else emit(tab, formatted);
      } },
    sed: { group: "Text", usage: "sed [-n] [-E] [-i] 'SCRIPT' [file]", desc: mariowOSI18n.t("terminal.cmd.sed", "Edit text as it flows: sed 's/old/new/g', sed '/pattern/d', sed -n '2,5p'"), complete: "any",
      details: mariowOSI18n.t("terminal.cmd.sed-details", "Commands (separate several with ; or repeat -e):\n  s/RE/TEXT/[g][i][N][p]  replace (& is the match, \\1..\\9 the groups)\n  d   delete the line        p   print it (with -n only printed lines are shown)\n  q   stop after the line\nAddresses: 3, $, /RE/, 2,5 or /start/,/end/ before a command; ! negates them.\n  -i edits the file in place, -E uses extended regular expressions."),
      run: async (tab, args) => {
        const { opts, rest } = getopt(args, { flags: "nEri", values: "e", long: { quiet: "n", silent: "n", "regexp-extended": "E", "in-place": "i", expression: "e" } });
        const extended = opts.E || opts.r;
        const script = opts.e !== undefined ? list(opts.e).join(";") : rest.shift();
        if (script === undefined) throw usageError("sed");
        const commands = parseSed(script, extended);
        if (opts.i && !rest.length) throw new Error(mariowOSI18n.t("terminal.sed.in-place-file", "-i needs a file to edit"));
        const files = opts.i ? rest : [null];
        for (const file of files) {
          const text = file ? await readHomeFile(tab, file) : await inputText(tab, rest, "sed");
          const lines = textLines(text);
          const out = [];
          const ranges = commands.map(() => ({ active: false }));
          let quit = false;
          for (let n = 0; n < lines.length && !quit; n++) {
            let line = lines[n];
            let deleted = false;
            const isLast = n === lines.length - 1;
            for (let c = 0; c < commands.length; c++) {
              const command = commands[c];
              if (!sedMatches(command, ranges[c], line, n + 1, isLast)) continue;
              if (command.op === "d") { deleted = true; break; }
              if (command.op === "p") out.push(line);
              if (command.op === "q") quit = true;
              if (command.op === "s") {
                let count = 0, replaced = false;
                line = line.replace(command.re, (...m) => {
                  count++;
                  if (command.nth && count !== command.nth) return m[0];
                  replaced = true;
                  return command.replacement.replace(/\\(\d)|&|\\n|\\t|\\&|\\\\/g, token => token === "&" ? m[0] : token === "\\&" ? "&" : token === "\\\\" ? "\\" : token === "\\n" ? "\n" : token === "\\t" ? "\t" : (m[+token[1]] ?? ""));
                });
                if (replaced && command.print) out.push(line);
              }
            }
            if (!deleted && !opts.n) out.push(line);
          }
          if (file) await writeHomeFile(tab, file, out.length ? out.join("\n") + "\n" : "");
          else emit(tab, out.length ? out.join("\n").split("\n") : []);
        }
      } },
    base64: { group: "Text", usage: "base64 [-d] [file]", desc: mariowOSI18n.t("terminal.cmd.base64", "Encode to base64, or decode with -d"), complete: "any",
      run: async (tab, args) => {
        const { opts, rest } = getopt(args, { flags: "dw", long: { decode: "d" } });
        const text = await inputText(tab, rest, "base64");
        if (opts.d) {
          let bytes;
          try { bytes = Uint8Array.from(atob(text.replace(/\s+/g, "")), c => c.charCodeAt(0)); }
          catch (error) { throw new Error(mariowOSI18n.t("terminal.base64.invalid", "invalid input")); }
          printText(tab, new TextDecoder().decode(bytes));
          return;
        }
        let binary = "";
        utf8.encode(text).forEach(b => { binary += String.fromCharCode(b); });
        const encoded = btoa(binary);
        emit(tab, encoded.match(/.{1,76}/g) || [""]);
      } },
    sha256sum: { group: "Text", usage: "sha256sum [file...]", desc: mariowOSI18n.t("terminal.cmd.sha256sum", "Print the SHA-256 checksum (also sha1sum, sha512sum)"), complete: "any",
      run: (tab, args) => hashCommand(tab, args, "SHA-256") },
    sha1sum: { group: "Text", usage: "sha1sum [file...]", desc: "", hidden: true, complete: "any", run: (tab, args) => hashCommand(tab, args, "SHA-1") },
    sha512sum: { group: "Text", usage: "sha512sum [file...]", desc: "", hidden: true, complete: "any", run: (tab, args) => hashCommand(tab, args, "SHA-512") },
    json: { group: "Text", usage: "json [-c] [-r] [.path] [file]", desc: mariowOSI18n.t("terminal.cmd.json", "Pretty-print JSON, or pick a value: curl -s URL | json .items[0].name"), complete: "any",
      run: async (tab, args) => {
        const { opts, rest } = getopt(args, { flags: "crk", long: { compact: "c", raw: "r", keys: "k" } });
        const query = rest[0] && rest[0].startsWith(".") ? rest.shift() : ".";
        const text = await inputText(tab, rest, "json");
        let value;
        try { value = JSON.parse(text); } catch (error) { throw new Error(mariowOSI18n.t("terminal.json.invalid", "not valid JSON: {error}", { error: error.message })); }
        const steps = query.replace(/^\./, "").match(/[^.[\]]+|\[\d+\]|\[\]/g) || [];
        let results = [value];
        for (const step of steps) {
          results = results.flatMap(v => {
            if (step === "[]") return Array.isArray(v) ? v : v && typeof v === "object" ? Object.values(v) : [];
            const key = /^\[\d+\]$/.test(step) ? +step.slice(1, -1) : step.replace(/^"|"$/g, "");
            return v !== null && v !== undefined && typeof v === "object" ? [v[key]] : [undefined];
          });
        }
        const lines = [];
        results.forEach(v => {
          if (opts.k && v && typeof v === "object") { Object.keys(v).forEach(k => lines.push(k)); return; }
          if (v === undefined) { lines.push("null"); return; }
          if (opts.r && typeof v === "string") { lines.push(...v.split("\n")); return; }
          lines.push(...JSON.stringify(v, null, opts.c ? 0 : 2).split("\n"));
        });
        emit(tab, lines);
      } },
    printf: { group: "Text", usage: "printf FORMAT [args...]", desc: mariowOSI18n.t("terminal.cmd.printf", "Print formatted text: printf '%-10s %5.2f\\n' name 3.14159"),
      run: (tab, args) => {
        if (args.length < 2) throw usageError("printf");
        const text = formatPrintf(args[1], args.slice(2));
        const lines = text.split("\n");
        const open = lines[lines.length - 1] !== "";
        if (!open) lines.pop();
        emit(tab, lines);
        if (open && isCapturing(tab)) tab.io.noNewline = true;
      } },
    xargs: { group: "Shell", usage: "xargs [-n N] [-I {}] <command> [args...]", desc: mariowOSI18n.t("terminal.cmd.xargs", "Run a command with the words piped in as its arguments: ls *.txt | xargs rm"),
      run: async (tab, args) => {
        let k = 1, per = Infinity, placeholder = null;
        for (; k < args.length && args[k].startsWith("-"); k++) {
          if (args[k] === "-n") per = toInt(args[++k], "xargs");
          else if (args[k] === "-I") placeholder = args[++k];
          else throw usageError("xargs");
        }
        const command = args.slice(k);
        if (!command.length) command.push("echo");
        const input = readStdin(tab);
        if (input === null) throw new Error(mariowOSI18n.t("terminal.xargs.stdin", "xargs reads what is piped into it, e.g. ls | xargs echo"));
        const items = placeholder ? textLines(input) : (input.match(/"[^"]*"|'[^']*'|\S+/g) || []).map(w => w.replace(/^(["'])(.*)\1$/, "$2"));
        const frame = { ...tab.io, stdin: null };
        let status = 0;
        if (placeholder) {
          for (const item of items) { checkInterrupt(tab); status = await tab.shell.invoke(command.map(a => a.split(placeholder).join(item)), frame) || status; }
        } else {
          for (let i = 0; i < Math.max(items.length, 1); i += per === Infinity ? Math.max(items.length, 1) : per) {
            checkInterrupt(tab);
            status = await tab.shell.invoke(command.concat(items.slice(i, i + (per === Infinity ? items.length : per))), frame) || status;
          }
        }
        return status ? 123 : 0;
      } },

    // --- network
    curl: { group: "Network", usage: CURL_HELP, desc: mariowOSI18n.t("terminal.cmd.curl", "Transfer data from or to a URL (-X method, -H header, -d data, -o file, -L follow, -i headers)"),
      details: mariowOSI18n.t("terminal.cmd.curl-details", "  -X, --request METHOD    GET, POST, PUT, DELETE...\n  -H, --header 'K: V'      add a request header (repeatable)\n  -d, --data DATA          send data (POST); -d @file reads it from a file\n      --json DATA          send JSON\n  -G, --get                put the -d data in the URL instead\n  -u, --user user:pass     basic authentication\n  -A, --user-agent UA      -e, --referer URL     -b, --cookie 'a=b'\n  -i, --include            print the response headers too\n  -I, --head               headers only (HEAD request)\n  -L, --location           follow redirects\n  -o, --output FILE        save to a file in your home     -O  name it after the URL\n  -f, --fail               no output and exit status 22 on HTTP errors\n  -s, --silent  -S, --show-error   -v, --verbose   -m, --max-time SECONDS\n  -w, --write-out FORMAT   e.g. -w '%{http_code}\\n' (also %{size_download} %{time_total} %{url_effective} %{content_type})"),
      run: (tab, args) => runCurl(tab, args) },
    wget: { group: "Network", usage: "wget [-O file] [-q] <url>", desc: mariowOSI18n.t("terminal.cmd.wget", "Download a file into the current folder"),
      run: (tab, args) => runWget(tab, args) },
    telnet: { group: "Network", usage: "telnet <host> [port]", desc: mariowOSI18n.t("terminal.cmd.telnet", "Open an interactive text connection (port 23 by default); Ctrl+] closes it"),
      run: (tab, args) => {
        if (args.length < 2 || args.length > 3) throw usageError("telnet");
        const port = args[2] ? toInt(args[2], "telnet") : 23;
        return runSocket(tab, args[1], port, false);
      } },
    nc: { group: "Network", usage: "nc [-w secs] <host> <port>", desc: mariowOSI18n.t("terminal.cmd.nc", "Raw TCP connection (netcat): type to send, or pipe text into it"),
      run: (tab, args) => {
        const { opts, rest } = getopt(args, { flags: "v", values: "w" });
        if (rest.length !== 2) throw usageError("nc");
        return runSocket(tab, rest[0], toInt(rest[1], "nc"), true, { wait: opts.w ? Math.max(1, toInt(opts.w, "nc")) : 3 });
      } },
    ping: { group: "Network", usage: "ping [-c count] [-t] <host>", desc: mariowOSI18n.t("terminal.cmd.ping", "Check that a host answers, and how fast (-t until Ctrl+C)"),
      run: async (tab, args) => {
        const { opts, rest } = getopt(args, { flags: "t46", values: "cnW" });
        if (rest.length !== 1) throw usageError("ping");
        const host = rest[0];
        const count = opts.t ? Infinity : opts.c || opts.n ? toInt(opts.c || opts.n, "ping") : 4;
        const times = [];
        let sent = 0;
        for (let seq = 1; seq <= count; seq++) {
          if (tab.interrupted) break;
          let reply;
          try { reply = await api(`/api/terminal/ping?host=${encodeURIComponent(host)}`); }
          catch (error) { if (seq === 1) throw Object.assign(new Error(error.message), { status: 2 }); break; }
          if (seq === 1) printLine(tab, `PING ${host} (${reply.address})`);
          sent++;
          if (reply.alive) {
            times.push(reply.time);
            printLine(tab, `${mariowOSI18n.t("terminal.ping.reply", "reply from {address}", { address: reply.address })}: icmp_seq=${seq}${reply.ttl ? ` ttl=${reply.ttl}` : ""} time=${reply.time} ms`);
          } else {
            printLine(tab, mariowOSI18n.t("terminal.ping.timeout", "Request timeout for icmp_seq {seq}", { seq }), "color-yellow");
          }
          if (seq < count && !(await pause(tab, 1000))) break;
        }
        if (!sent) return 2;
        const loss = Math.round((1 - times.length / sent) * 100);
        printLine(tab, "");
        printLine(tab, `--- ${host} ${mariowOSI18n.t("terminal.ping.stats", "ping statistics")} ---`);
        printLine(tab, mariowOSI18n.t("terminal.ping.summary", "{sent} packets transmitted, {received} received, {loss}% packet loss", { sent, received: times.length, loss }));
        if (times.length) printLine(tab, `rtt min/avg/max = ${Math.min(...times)}/${(times.reduce((a, b) => a + b, 0) / times.length).toFixed(1)}/${Math.max(...times)} ms`);
        return times.length ? 0 : 1;
      } },
    nslookup: { group: "Network", usage: "nslookup <name> [type]", desc: mariowOSI18n.t("terminal.cmd.nslookup", "Look up the addresses (or MX, TXT, NS... records) of a name"),
      run: async (tab, args) => {
        if (args.length < 2 || args.length > 3) throw usageError("nslookup");
        const data = await api(`/api/terminal/dns?name=${encodeURIComponent(args[1])}&type=${encodeURIComponent(args[2] || "")}`);
        if (data.server) { printLine(tab, `Server:\t\t${data.server}`); printLine(tab, ""); }
        const lines = [];
        data.records.forEach(record => {
          if (record.type === "A" || record.type === "AAAA") lines.push(`Name:\t${data.name}`, `Address: ${record.value}`);
          else lines.push(`${data.name}\t${describeRecord(record)}`);
        });
        emit(tab, lines);
      } },
    dig: { group: "Network", usage: "dig <name> [type]", desc: mariowOSI18n.t("terminal.cmd.dig", "DNS records in dig's one-line format"),
      run: async (tab, args) => {
        const rest = args.slice(1).filter(a => !a.startsWith("+"));
        if (!rest.length || rest.length > 2) throw usageError("dig");
        const [name, typeArg] = /^[A-Za-z]{1,5}$/.test(rest[0]) && rest[1] && rest[0].toUpperCase() === rest[0] ? [rest[1], rest[0]] : rest;
        const type = (typeArg || "A").toUpperCase();
        const data = await api(`/api/terminal/dns?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`);
        emit(tab, data.records.map(record => `${data.name}.\tIN\t${record.type}\t${recordValue(record)}`));
      } },
    ifconfig: { group: "Network", usage: "ifconfig  (or: ip a)", desc: mariowOSI18n.t("terminal.cmd.ifconfig", "Show the network interfaces and their addresses"),
      run: async tab => {
        const data = await api("/api/terminal/netinfo");
        const lines = [];
        data.interfaces.forEach((iface, k) => {
          if (k) lines.push("");
          lines.push(`${iface.name}:${iface.addresses.some(a => a.internal) ? " (loopback)" : ""}`);
          iface.addresses.forEach(a => lines.push(`        ${a.family} ${a.address}${a.netmask ? `  netmask ${a.netmask}` : ""}`));
          const mac = (iface.addresses.find(a => a.mac && a.mac !== "00:00:00:00:00:00") || {}).mac;
          if (mac) lines.push(`        ether ${mac}`);
        });
        emit(tab, lines);
      } },
    ip: { group: "Network", usage: "ip a", desc: "", hidden: true, run: (tab, args) => { if (args[1] && !/^(a|addr|address)$/.test(args[1])) throw usageError("ip"); return COMMANDS.ifconfig.run(tab, args); } },
    hostname: { group: "Network", usage: "hostname", desc: mariowOSI18n.t("terminal.cmd.hostname", "Print the name of this computer"),
      run: async tab => printLine(tab, (await api("/api/terminal/netinfo")).hostname) },

    // --- system
    store: { group: "System", usage: "store <command> [args]", desc: mariowOSI18n.t("terminal.cmd.store", "Store from the terminal: add apps from GitHub or your home, publish, list, info, remove"),
      complete: async (tab, index, args) => {
        if (index === 1) return Object.keys(STORE_SUBCOMMANDS);
        if (index === 2 && ["remove", "info"].includes(args[1])) return (await installedApps()).map(app => app.appId);
        if (index === 2 && args[1] === "add") return "any";
        return null;
      },
      run: (tab, args) => runStore(tab, args) },
    ps: { group: "System", usage: "ps", desc: mariowOSI18n.t("terminal.cmd.ps", "List the open app windows"),
      run: tab => {
        const windows = desktopWindows();
        if (!windows.length) { printLine(tab, mariowOSI18n.t("terminal.ps.none", "No app windows are open (or this terminal is not on the desktop).")); return; }
        printTable(tab, "", ["PID", mariowOSI18n.t("terminal.table.window", "window"), mariowOSI18n.t("terminal.table.app", "app"), mariowOSI18n.t("terminal.table.state", "state")], windows.map((w, k) => [String(k + 1), w.id, w.title, w.state]));
      } },
    kill: { group: "System", usage: "kill <pid|window|app>", desc: mariowOSI18n.t("terminal.cmd.kill", "Close an app window (see ps)"),
      complete: (tab, index) => index === 1 ? desktopWindows().map(w => w.id) : null,
      run: (tab, args) => {
        if (args.length < 2) throw usageError("kill");
        const windows = desktopWindows();
        let status = 0;
        for (const target of args.slice(1).filter(a => !/^-\d+$|^-[A-Z]+$/.test(a))) {
          const lower = target.toLowerCase();
          const found = /^\d+$/.test(target) ? windows[+target - 1] : windows.find(w => w.id.toLowerCase() === lower || w.title.toLowerCase() === lower);
          if (!found) { printError(tab, `kill: ${target}: ${mariowOSI18n.t("terminal.kill.none", "no such window (see 'ps')")}`); status = 1; continue; }
          window.parent.postMessage({ type: "close-app", appId: found.id }, window.location.origin);
        }
        return status;
      } },
    notify: { group: "System", usage: "notify <title> [message]", desc: mariowOSI18n.t("terminal.cmd.notify", "Show a desktop notification (handy at the end of a long script)"),
      run: (tab, args) => {
        if (args.length < 2) throw usageError("notify");
        if (!IS_EMBEDDED) throw new Error(mariowOSI18n.t("terminal.open.desktop-only", "apps can only be opened from the mariowOS desktop"));
        window.parent.postMessage({ type: "show-notification", title: args[1], msg: args.slice(2).join(" "), icon: "🖥️" }, window.location.origin);
      } }
  };
  Object.assign(COMMANDS, NEW_COMMANDS);

  // Commands that are only spellings of another one stay out of the help tables.
  const listedInHelp = command => !command.hidden;
  const originalShowHelp = showHelp;
  showHelp = function (tab, name) {
    if (name === "store") { showStoreHelp(tab); return; }
    if (name) return originalShowHelp(tab, name);
    COMMAND_GROUPS.forEach(group => {
      const rows = Object.values(COMMANDS).filter(command => command.group === group && listedInHelp(command)).map(command => [command.usage, command.desc]);
      if (rows.length) printTable(tab, commandGroupTitle(group), commandTableHeaders(), rows);
    });
    printLine(tab, mariowOSI18n.t("terminal.help.footer", "Tab completes commands, paths, packages and apps · ↑/↓ browse the history · → accepts the grey suggestion\nCtrl+C cancels the line · Ctrl+L clears the screen · Ctrl+T / Ctrl+W open / close a tab · 'help <command>' for details"), "color-gray");
    printLine(tab, mariowOSI18n.t("terminal.help.footer-shell", "Pipes (|), redirections (> >> <), ; && ||, $variables and $(commands) all work · 'help mwex' explains .mwex scripts"), "color-gray");
  };

  // --- helpers used above
  async function hashCommand(tab, args, algorithm) {
    const files = args.slice(1);
    const targets = files.length ? files : ["-"];
    let status = 0;
    for (const file of targets) {
      let text;
      try { text = await inputText(tab, [file], args[0]); }
      catch (error) { printError(tab, `${args[0]}: ${error.message}`); status = 1; continue; }
      const digest = await crypto.subtle.digest(algorithm, utf8.encode(text));
      printLine(tab, `${toHex(digest)}  ${file}`);
    }
    return status;
  }

  function recordValue(record) {
    const v = record.value;
    switch (record.type) {
      case "MX": return `${v.priority} ${v.exchange}.`;
      case "TXT": return `"${[].concat(v).join("")}"`;
      case "SOA": return `${v.nsname}. ${v.hostmaster}. ${v.serial} ${v.refresh} ${v.retry} ${v.expire} ${v.minttl}`;
      case "SRV": return `${v.priority} ${v.weight} ${v.port} ${v.name}.`;
      case "CAA": return `${v.critical || 0} ${Object.keys(v).filter(k => k !== "critical")[0] || ""} "${Object.values(v).filter((x, k) => Object.keys(v)[k] !== "critical")[0] || ""}"`;
      case "CNAME": case "NS": case "PTR": return `${v}.`;
      default: return String(v);
    }
  }
  function describeRecord(record) {
    const labels = { MX: "mail exchanger =", TXT: "text =", CNAME: "canonical name =", NS: "nameserver =", PTR: "name =", SOA: "origin =", SRV: "service =", CAA: "caa =" };
    return `${labels[record.type] || `${record.type} =`} ${recordValue(record)}`;
  }

  function parseSed(script, extended) {
    const commands = [];
    let i = 0;
    const s = script;
    const skipSpace = () => { while (i < s.length && /[\s;]/.test(s[i])) i++; };
    const readRegex = delimiter => {
      let out = "";
      while (i < s.length && s[i] !== delimiter) {
        if (s[i] === "\\" && s[i + 1] === delimiter) { out += delimiter; i += 2; continue; }
        if (s[i] === "\\" && i + 1 < s.length) { out += s[i] + s[i + 1]; i += 2; continue; }
        out += s[i++];
      }
      if (s[i] !== delimiter) throw new Error(mariowOSI18n.t("terminal.sed.unterminated", "unterminated expression in '{script}'", { script }));
      i++;
      return out;
    };
    const readAddress = () => {
      if (s[i] === "$") { i++; return { last: true }; }
      if (/\d/.test(s[i])) { let n = ""; while (/\d/.test(s[i])) n += s[i++]; return { line: +n }; }
      if (s[i] === "/" || s[i] === "\\") {
        const delimiter = s[i] === "\\" ? s[++i] : "/";
        i++;
        return { re: makeRegExp(regexSource(readRegex(delimiter), extended), "") };
      }
      return null;
    };
    while (true) {
      skipSpace();
      if (i >= s.length) break;
      const command = {};
      command.from = readAddress();
      if (command.from && s[i] === ",") { i++; command.to = readAddress(); if (!command.to) throw new Error(mariowOSI18n.t("terminal.sed.bad-address", "bad address in '{script}'", { script })); }
      while (s[i] === " ") i++;
      if (s[i] === "!") { command.negate = true; i++; }
      const op = s[i++];
      if (op === "d" || op === "p" || op === "q") command.op = op;
      else if (op === "s") {
        const delimiter = s[i++];
        if (!delimiter || /[\s\\\n]/.test(delimiter)) throw new Error(mariowOSI18n.t("terminal.sed.bad-command", "unknown command in '{script}'", { script }));
        const pattern = readRegex(delimiter);
        const replacement = readRegex(delimiter);
        let flags = "", nth = 0, print = false;
        while (i < s.length && /[gipI0-9]/.test(s[i])) {
          const f = s[i++];
          if (f === "g") flags += "g"; else if (f === "i" || f === "I") flags += "i"; else if (f === "p") print = true; else nth = nth * 10 + +f;
        }
        if (nth && !flags.includes("g")) flags += "g";
        command.op = "s";
        command.re = makeRegExp(regexSource(pattern, extended), flags);
        command.replacement = replacement;
        command.nth = nth;
        command.print = print;
      } else throw new Error(mariowOSI18n.t("terminal.sed.bad-command", "unknown command in '{script}'", { script }));
      commands.push(command);
    }
    return commands;
  }
  function sedMatches(command, range, line, number, isLast) {
    const test = address => address.last ? isLast : address.line !== undefined ? address.line === number : address.re.test(line);
    let hit;
    if (!command.from) hit = true;
    else if (!command.to) hit = test(command.from);
    else if (range.active) {
      hit = true;
      if (command.to.line !== undefined ? number >= command.to.line : test(command.to)) range.active = false;
    } else if (test(command.from)) {
      hit = true;
      range.active = !(command.to.line !== undefined && command.to.line <= number);
    } else hit = false;
    return command.negate ? !hit : hit;
  }

  // ---------------------------------------------------------------- help mwex
  HELP_TOPICS.mwex = tab => {
    printHTML(tab, `<span class="color-blue">${escapeHtml(mariowOSI18n.t("terminal.mwex.title", ".mwex — mariowOS executables"))}</span>`);
    printLine(tab, mariowOSI18n.t("terminal.mwex.body",
`A .mwex file is a text file of terminal commands that runs top to bottom, like a .sh script.

  nano hello.mwex              write it
  ./hello.mwex world           run it (only .mwex files are executable)
  sh hello.mwex world          the same; sh runs any text file as a script
  mkdir -p ~/bin && mv hello.mwex ~/bin
  hello world                  scripts in ~/bin (your $PATH) run by name, from anywhere

Example:
  #!/bin/mwsh
  # greet everyone named on the command line
  if [ $# -eq 0 ]; then
    echo "usage: hello <name>..."; exit 1
  fi
  for name in "$@"; do
    echo "Hello, $name! It is $(date +%H:%M)."
  done
  count=$(ls ~ | wc -l)
  echo "Your home has $count items, $((count * 2)) if you doubled them."

What the language knows:
  variables      name=value  $name  \${name:-default}  \${file%.mwex}  \${#name}
  arguments      $1 ... $9   $# (how many)   "$@" (all of them)   $0 (the script)
  status         $? is the last command's exit status; exit N ends the script
  substitution   $(command)  and  $((arithmetic))
  combining      a | b   a; b   a && b   a || b   ! a
  files          > file   >> file   < file   2> file   2>&1   &> file   (> /dev/null discards)
  conditions     if ...; then ...; elif ...; else ...; fi    test / [ -f file ] [ "$a" = b ] [ $n -lt 5 ]
  loops          for x in a b c; do ...; done    while ...; do ...; done    until ...    break / continue
  choices        case $x in start|go) ...;; *.txt) ...;; *) ...;; esac
  functions      greet() { local who=$1; echo "hi $who"; return 0; }
  input          read -p "Name? " name     (or from a pipe: cat list.txt | while read line; do ...; done)
  options        set -e (stop at the first error)   set -x (print each command)
  quoting        'single: nothing expands'   "double: $vars expand"   \\ escapes one character

~/.mwshrc runs whenever a terminal tab opens: the place for your aliases and functions.`));
  };
  HELP_TOPICS.scripting = HELP_TOPICS.mwex;
})();
