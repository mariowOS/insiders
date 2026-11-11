// Network tools for the Terminal app: curl/wget (HTTP), telnet/nc (TCP), ping, DNS
// lookups and the network interfaces. A page cannot do these itself (CORS, no raw
// sockets), so the kernel does them on its behalf.
//
// Every route here is for administrators only (see ADMIN_ONLY_ROUTES in server.js), like
// the Terminal itself, and every TCP session belongs to the account that opened it.
"use strict";

const net = require("net");
const dns = require("dns").promises;
const os = require("os");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const MAX_BODY_BYTES = 25 * 1024 * 1024;     // what curl reads into memory
const MAX_INLINE_BINARY = 5 * 1024 * 1024;   // binary bodies sent back to the page
const MAX_SESSIONS_PER_USER = 4;
const SESSION_IDLE_MS = 30 * 60 * 1000;
const HOST_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)*\.?|\[?[0-9A-Fa-f:.]+\]?)$/;
const DNS_TYPES = ["A", "AAAA", "CNAME", "MX", "NS", "TXT", "SOA", "SRV", "PTR", "CAA"];

const cleanHost = value => {
  const host = String(value || "").trim();
  if (!host || host.length > 253 || !HOST_RE.test(host)) return null;
  return host.replace(/^\[|\]$/g, "");
};

// curl's own exit codes, so scripts can test $? the usual way.
function describeFetchError(error, url, timedOut) {
  const cause = error && (error.cause || error);
  const code = cause && cause.code;
  if (timedOut) return { code: 28, error: "Operation timed out" };
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return { code: 6, error: `Could not resolve host: ${url.hostname}` };
  if (code === "ECONNREFUSED") return { code: 7, error: `Failed to connect to ${url.hostname} port ${url.port || (url.protocol === "https:" ? 443 : 80)}: Connection refused` };
  if (code === "ECONNRESET") return { code: 56, error: "Connection reset by peer" };
  if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") return { code: 28, error: "Connection timed out" };
  if (code && /CERT|SSL|TLS|SELF_SIGNED/i.test(code)) return { code: 60, error: `SSL certificate problem: ${cause.message || code}` };
  if (error && error.name === "AbortError") return { code: 42, error: "Operation aborted" };
  return { code: 7, error: (cause && cause.message) || String(error) };
}

function looksLikeText(contentType, buffer) {
  if (/^(text\/|application\/(json|xml|javascript|ecmascript|x-www-form-urlencoded|ld\+json|problem\+json|[\w.+-]*\+(json|xml)))|image\/svg\+xml/i.test(contentType || "")) return true;
  if (/^(image|audio|video|font)\/|application\/(octet-stream|zip|pdf|gzip|x-)/i.test(contentType || "")) return false;
  const sample = buffer.subarray(0, 8000);
  if (sample.includes(0)) return false;
  try { new TextDecoder("utf-8", { fatal: true }).decode(sample); return true; } catch (error) { return false; }
}

// ---------------------------------------------------------------- telnet / nc
const IAC = 255, DONT = 254, DO = 253, WONT = 252, WILL = 251, SB = 250, SE = 240;
const OPT_ECHO = 1, OPT_SGA = 3;

// Strips the telnet protocol out of the stream and answers the server's option
// negotiation: we accept its echo and suppress-go-ahead and decline everything else.
function telnetFilter(session, chunk) {
  const out = [];
  const reply = [];
  const answer = (cmd, opt) => {
    const key = `${cmd}:${opt}`;
    if (session.answered.has(key)) return;
    session.answered.add(key);
    reply.push(IAC, cmd, opt);
  };
  for (const byte of chunk) {
    switch (session.state) {
      case 0:
        if (byte === IAC) session.state = 1; else out.push(byte);
        break;
      case 1:
        if (byte === IAC) { out.push(IAC); session.state = 0; }
        else if (byte >= WILL && byte <= DONT) { session.command = byte; session.state = 2; }
        else if (byte === SB) session.state = 3;
        else session.state = 0;
        break;
      case 2: {
        const cmd = session.command;
        session.state = 0;
        if (cmd === WILL) {
          const accept = byte === OPT_ECHO || byte === OPT_SGA;
          answer(accept ? DO : DONT, byte);
          if (byte === OPT_ECHO) session.serverEcho = accept;
        } else if (cmd === WONT) {
          if (byte === OPT_ECHO) session.serverEcho = false;
          answer(DONT, byte);
        } else if (cmd === DO) {
          answer(byte === OPT_SGA ? WILL : WONT, byte);
        } else if (cmd === DONT) {
          answer(WONT, byte);
        }
        break;
      }
      case 3: if (byte === IAC) session.state = 4; break;
      case 4: session.state = byte === SE ? 0 : 3; break;
    }
  }
  if (reply.length && !session.socket.destroyed) session.socket.write(Buffer.from(reply));
  return Buffer.from(out);
}

function registerTerminalNetRoutes(app, { requireAuth, resolveHomeEntry }) {
  const sessions = new Map();
  const owner = req => (req.user && req.user.id) || "owner";

  // --- curl / wget
  app.post("/api/terminal/http", requireAuth, async (req, res) => {
    const { url, method = "GET", headers = {}, body, follow = false, timeout = 30, saveTo } = req.body || {};
    let target;
    try { target = new URL(String(url)); } catch (error) { return res.status(400).json({ success: false, code: 3, error: "URL rejected: Malformed input to a URL function" }); }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      return res.status(400).json({ success: false, code: 1, error: `Protocol "${target.protocol.replace(/:$/, "")}" not supported` });
    }
    const verb = String(method).toUpperCase();
    if (!/^[A-Z]{1,16}$/.test(verb)) return res.status(400).json({ success: false, code: 2, error: "Invalid request method" });
    const cleanHeaders = {};
    for (const [key, value] of Object.entries(headers && typeof headers === "object" ? headers : {})) {
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || /[\r\n]/.test(String(value))) {
        return res.status(400).json({ success: false, code: 2, error: `Invalid header: ${key}` });
      }
      cleanHeaders[key] = String(value);
    }
    if (!Object.keys(cleanHeaders).some(key => key.toLowerCase() === "user-agent")) cleanHeaders["User-Agent"] = "curl/8.0 (mariowOS Terminal)";
    if (!Object.keys(cleanHeaders).some(key => key.toLowerCase() === "accept")) cleanHeaders.Accept = "*/*";

    // Where -o / -O saves: decided before the request, so a bad path fails fast.
    let destination = null;
    if (saveTo) {
      const virtualPath = path.posix.normalize(String(saveTo));
      destination = resolveHomeEntry(path.posix.dirname(virtualPath), path.posix.basename(virtualPath));
      if (!destination) return res.status(403).json({ success: false, code: 23, error: `${saveTo}: files can only be saved in your home partition` });
      destination.virtualPath = virtualPath;
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, Math.max(1, Math.min(300, Number(timeout) || 30)) * 1000);
    // The page went away (Ctrl+C): stop downloading.
    res.on("close", () => { if (!res.writableFinished) controller.abort(); });

    const started = Date.now();
    let response;
    try {
      const options = {
        method: verb,
        headers: cleanHeaders,
        body: verb === "GET" || verb === "HEAD" || body === undefined || body === null ? undefined : String(body),
        redirect: follow ? "follow" : "manual",
        signal: controller.signal
      };
      response = await fetch(target, options);
    } catch (error) {
      clearTimeout(timer);
      return res.status(502).json({ success: false, ...describeFetchError(error, target, timedOut) });
    }

    const chunks = [];
    let size = 0;
    try {
      if (response.body && verb !== "HEAD") {
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) {
            controller.abort();
            clearTimeout(timer);
            return res.status(413).json({ success: false, code: 63, error: `Maximum file size exceeded (${MAX_BODY_BYTES / 1048576} MB)` });
          }
          chunks.push(Buffer.from(chunk));
        }
      }
    } catch (error) {
      clearTimeout(timer);
      if (res.writableEnded || res.destroyed) return;
      return res.status(502).json({ success: false, ...describeFetchError(error, target, timedOut) });
    }
    clearTimeout(timer);

    const buffer = Buffer.concat(chunks);
    const contentType = response.headers.get("content-type") || "";
    const responseHeaders = [];
    response.headers.forEach((value, key) => { if (key !== "set-cookie") responseHeaders.push([key, value]); });
    (response.headers.getSetCookie ? response.headers.getSetCookie() : []).forEach(value => responseHeaders.push(["set-cookie", value]));

    const result = {
      success: true,
      status: response.status,
      statusText: response.statusText,
      url: response.url || target.href,
      redirected: response.redirected,
      headers: responseHeaders,
      size: buffer.length,
      time: (Date.now() - started) / 1000,
      contentType
    };
    if (destination) {
      try {
        fs.writeFileSync(destination.full, buffer);
        result.saved = destination.virtualPath;
      } catch (error) {
        return res.status(500).json({ success: false, code: 23, error: `Failure writing output to destination: ${error.message}` });
      }
    } else if (looksLikeText(contentType, buffer)) {
      result.text = buffer.toString("utf8");
    } else {
      result.binary = true;
      if (buffer.length <= MAX_INLINE_BINARY) result.base64 = buffer.toString("base64");
    }
    res.json(result);
  });

  // --- telnet / nc
  function closeSession(session) {
    if (session.closed) return;
    session.closed = true;
    try { session.socket.destroy(); } catch (error) {}
    session.clients.forEach(client => { try { client.write("event: close\ndata: {}\n\n"); client.end(); } catch (error) {} });
    session.clients.clear();
    clearTimeout(session.idleTimer);
    setTimeout(() => sessions.delete(session.id), 30000);
  }
  function touch(session) {
    clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => closeSession(session), SESSION_IDLE_MS);
  }
  function emit(session, event, payload) {
    const message = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    if (session.clients.size) session.clients.forEach(client => client.write(message));
    else session.backlog.push(message);
  }
  const sessionFor = (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session || session.owner !== owner(req)) { res.status(404).json({ success: false, error: "No such connection" }); return null; }
    return session;
  };

  app.post("/api/terminal/socket/open", requireAuth, (req, res) => {
    const host = cleanHost(req.body && req.body.host);
    const port = Number(req.body && req.body.port);
    const raw = !!(req.body && req.body.raw);
    if (!host) return res.status(400).json({ success: false, error: "Invalid host name" });
    if (!Number.isInteger(port) || port < 1 || port > 65535) return res.status(400).json({ success: false, error: "Invalid port number" });
    const mine = [...sessions.values()].filter(s => s.owner === owner(req) && !s.closed);
    if (mine.length >= MAX_SESSIONS_PER_USER) return res.status(429).json({ success: false, error: "Too many open connections; close one first" });

    const socket = net.connect({ host, port });
    const session = {
      id: crypto.randomBytes(12).toString("hex"), owner: owner(req), socket, raw,
      state: 0, command: 0, answered: new Set(), serverEcho: false,
      clients: new Set(), backlog: [], closed: false, idleTimer: null,
      decoder: new TextDecoder("utf-8")
    };
    let answered = false;
    socket.setTimeout(10000);
    socket.once("timeout", () => {
      if (!answered) { answered = true; socket.destroy(); res.status(504).json({ success: false, error: "Connection timed out" }); }
    });
    socket.once("connect", () => {
      socket.setTimeout(0);
      answered = true;
      sessions.set(session.id, session);
      touch(session);
      res.json({ success: true, id: session.id, address: socket.remoteAddress, port });
    });
    socket.on("data", chunk => {
      touch(session);
      const data = raw ? chunk : telnetFilter(session, chunk);
      const text = session.decoder.decode(data, { stream: true });
      if (text) emit(session, "data", { text, echo: session.serverEcho });
      else if (!raw) emit(session, "data", { text: "", echo: session.serverEcho });
    });
    socket.on("error", error => {
      if (!answered) {
        answered = true;
        const messages = { ECONNREFUSED: "Connection refused", ENOTFOUND: "Name or service not known", EAI_AGAIN: "Name or service not known", EHOSTUNREACH: "No route to host", ENETUNREACH: "Network is unreachable", ETIMEDOUT: "Connection timed out" };
        return res.status(502).json({ success: false, error: messages[error.code] || error.message });
      }
      emit(session, "error", { error: error.message });
    });
    socket.on("close", () => { if (answered) closeSession(session); });
  });

  app.get("/api/terminal/socket/:id/stream", requireAuth, (req, res) => {
    const session = sessionFor(req, res);
    if (!session) return;
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write(": connected\n\n");
    session.backlog.splice(0).forEach(message => res.write(message));
    if (session.closed) { res.write("event: close\ndata: {}\n\n"); return res.end(); }
    session.clients.add(res);
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 20000);
    res.on("close", () => { clearInterval(heartbeat); session.clients.delete(res); });
  });

  app.post("/api/terminal/socket/:id/send", requireAuth, (req, res) => {
    const session = sessionFor(req, res);
    if (!session) return;
    if (session.closed) return res.status(410).json({ success: false, error: "Connection closed" });
    let data = Buffer.from(String((req.body && req.body.data) || ""), "utf8");
    if (!session.raw && data.includes(IAC)) data = Buffer.from([...data].flatMap(byte => byte === IAC ? [IAC, IAC] : [byte]));
    touch(session);
    session.socket.write(data);
    res.json({ success: true });
  });

  app.post("/api/terminal/socket/:id/close", requireAuth, (req, res) => {
    const session = sessionFor(req, res);
    if (!session) return;
    closeSession(session);
    res.json({ success: true });
  });

  // --- ping: one echo request per call, so the page prints replies as they come.
  app.get("/api/terminal/ping", requireAuth, async (req, res) => {
    const host = cleanHost(req.query.host);
    if (!host) return res.status(400).json({ success: false, error: "Invalid host name" });
    let address;
    try { address = (await dns.lookup(host)).address; }
    catch (error) { return res.status(404).json({ success: false, error: `${host}: Name or service not known` }); }
    const windows = process.platform === "win32";
    const args = windows ? ["-n", "1", "-w", "2000", address] : ["-c", "1", "-W", process.platform === "darwin" ? "2000" : "2", address];
    let output = "";
    const child = spawn("ping", args, { windowsHide: true });
    const killer = setTimeout(() => child.kill(), 6000);
    child.stdout.on("data", data => { output += data.toString("latin1"); });
    child.on("error", error => { clearTimeout(killer); if (!res.headersSent) res.status(500).json({ success: false, error: `ping is not available: ${error.message}` }); });
    child.on("close", () => {
      clearTimeout(killer);
      if (res.headersSent) return;
      const time = output.match(/[=<]\s*([\d.,]+)\s*ms/i);
      const ttl = output.match(/ttl[=\s]*(\d+)/i);
      res.json({ success: true, address, alive: !!time, time: time ? parseFloat(time[1].replace(",", ".")) : null, ttl: ttl ? parseInt(ttl[1], 10) : null });
    });
  });

  // --- nslookup / dig
  app.get("/api/terminal/dns", requireAuth, async (req, res) => {
    const name = cleanHost(req.query.name);
    const type = String(req.query.type || "").toUpperCase();
    if (!name) return res.status(400).json({ success: false, error: "Invalid host name" });
    if (type && !DNS_TYPES.includes(type)) return res.status(400).json({ success: false, error: `Unsupported record type (use ${DNS_TYPES.join(", ")})` });
    const records = [];
    const add = (recordType, values) => (values || []).forEach(value => records.push({ type: recordType, value: typeof value === "string" ? value : value }));
    try {
      if (type === "PTR" || (!type && net.isIP(name))) {
        add("PTR", await dns.reverse(name));
      } else if (type) {
        add(type, await dns.resolve(name, type));
      } else {
        const found = await dns.lookup(name, { all: true });
        found.forEach(entry => records.push({ type: entry.family === 6 ? "AAAA" : "A", value: entry.address }));
        await dns.resolveCname(name).then(values => add("CNAME", values)).catch(() => {});
      }
    } catch (error) {
      const messages = { ENOTFOUND: `can't find ${name}: NXDOMAIN`, ENODATA: `${name} has no ${type || "address"} record`, ETIMEOUT: "connection timed out; no servers could be reached", ESERVFAIL: `can't find ${name}: SERVFAIL` };
      return res.status(404).json({ success: false, error: messages[error.code] || error.message });
    }
    res.json({ success: true, name, server: require("dns").getServers()[0] || "", records });
  });

  // --- ifconfig / ip
  app.get("/api/terminal/netinfo", requireAuth, (req, res) => {
    const interfaces = Object.entries(os.networkInterfaces()).map(([name, addresses]) => ({
      name,
      addresses: (addresses || []).map(entry => ({ family: entry.family === 6 || entry.family === "IPv6" ? "inet6" : "inet", address: entry.address, netmask: entry.netmask, cidr: entry.cidr, mac: entry.mac, internal: entry.internal }))
    }));
    res.json({ success: true, hostname: os.hostname(), interfaces });
  });
}

module.exports = { registerTerminalNetRoutes, telnetFilter };
