/*
mariowOS Terminal shell (mwsh) - (C) 2026 mariowstech and the mariowOS team
Licensed under the Apache License, Version 2.0.

The language the Terminal speaks and .mwex scripts are written in: a small POSIX-style
shell. It knows pipes (|), lists (; && ||), redirections (> >> < 2> 2>&1 &>), variables
and $(command) / $((arithmetic)) substitution, globbing (* ?), quoting, if / for / while /
until / case, functions, aliases and the usual builtins (export, read, test, source...).

It does not touch the page: the Terminal hands it a "host" that runs commands, prints,
reads and writes files. That keeps this file testable on its own (node shell.test.js).

  host.exec(argv, frame, shell)        -> status   run a command that is not a builtin
  host.write(frame, text) / error(...)          print to the frame's stdout / stderr
  host.readFile(path) / writeFile(path, text, append) / stat(path) / glob(pattern)
  host.readLine(prompt, { secret })    -> string   interactive input (read)
  host.which(name)                     -> { kind, path } | null
  host.cwd() / interrupted() / yield() / closeShell()

A frame is where a command reads and writes: { stdin: { text } | null, out: [] | null,
err: "screen" | "null" | "out" | [] }. out null means the screen.
*/
(function (global) {
  "use strict";

  class ShellSyntaxError extends Error {
    constructor(message, incomplete = false, line = 0) {
      super(message);
      this.incomplete = incomplete;
      this.line = line;
    }
  }
  class ExitSignal { constructor(status) { this.status = status; } }
  class ReturnSignal { constructor(status) { this.status = status; } }
  class LoopSignal { constructor(kind, levels) { this.kind = kind; this.levels = levels; } }
  class Interrupt extends Error { constructor() { super("interrupted"); } }

  const RESERVED = new Set(["if", "then", "elif", "else", "fi", "for", "in", "do", "done", "while", "until", "case", "esac", "{", "}", "function", "!"]);
  const REDIRECTS = new Set([">", ">>", "<", "2>", "2>>", "2>&1", "&>"]);
  const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

  // ---------------------------------------------------------------- tokenizer
  // A word is a list of parts so quoting survives until expansion:
  //   { t: "lit", v, q }   q: 0 unquoted, 1 single quotes / escaped, 2 double quotes
  //   { t: "param", name, op, arg, q }   $x ${x:-y} ${#x} ${x%.mwex} ...
  //   { t: "cmd", src, q }   $(...)        { t: "arith", src, q }   $((...))
  function findClosingParen(src, from) {
    let depth = 1;
    for (let j = from; j < src.length; j++) {
      const c = src[j];
      if (c === "\\") { j++; continue; }
      if (c === "'") { const end = src.indexOf("'", j + 1); if (end < 0) return -1; j = end; continue; }
      if (c === '"') {
        j++;
        while (j < src.length && src[j] !== '"') { if (src[j] === "\\") j++; j++; }
        if (j >= src.length) return -1;
        continue;
      }
      if (c === "(") depth++;
      else if (c === ")" && --depth === 0) return j;
    }
    return -1;
  }

  // Reads the expansion that starts with "$" at src[i]. Returns { part, end } or null
  // when the "$" is just a dollar sign.
  function readDollar(src, i, q, line) {
    const next = src[i + 1];
    if (next === "(" && src[i + 2] === "(") {
      // $((expr)): the inner "(" closes right before the outer ")".
      const close = findClosingParen(src, i + 3);
      if (close >= 0 && src[close + 1] === ")") return { part: { t: "arith", src: src.slice(i + 3, close), q }, end: close + 2 };
    }
    if (next === "(") {
      const close = findClosingParen(src, i + 2);
      if (close < 0) throw new ShellSyntaxError("unexpected end of input while looking for ')'", true, line);
      return { part: { t: "cmd", src: src.slice(i + 2, close), q }, end: close + 1 };
    }
    if (next === "{") {
      const close = src.indexOf("}", i + 2);
      if (close < 0) throw new ShellSyntaxError("unexpected end of input while looking for '}'", true, line);
      const body = src.slice(i + 2, close);
      let m;
      if ((m = body.match(/^#([A-Za-z_][A-Za-z0-9_]*|[0-9@*#?])$/))) return { part: { t: "param", name: m[1], op: "len", q }, end: close + 1 };
      if ((m = body.match(/^([A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?$])(?:(:-|:=|:\+|:\?|-|=|\+|##|#|%%|%|\/\/|\/)([\s\S]*))?$/))) {
        return { part: { t: "param", name: m[1], op: m[2] || "", arg: m[3] || "", q }, end: close + 1 };
      }
      throw new ShellSyntaxError(`\${${body}}: bad substitution`, false, line);
    }
    if (next && /[A-Za-z_]/.test(next)) {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      return { part: { t: "param", name: src.slice(i + 1, j), op: "", q }, end: j };
    }
    if (next && /[0-9?#@*$!]/.test(next)) return { part: { t: "param", name: next, op: "", q }, end: i + 2 };
    return null;
  }

  function tokenize(src) {
    const tokens = [];
    let parts = null;
    let raw = "";
    let line = 1;
    let wordLine = 1;
    const start = () => { if (!parts) { parts = []; raw = ""; wordLine = line; } };
    const lit = (v, q) => {
      start();
      const last = parts[parts.length - 1];
      if (last && last.t === "lit" && last.q === q) last.v += v;
      else parts.push({ t: "lit", v, q });
    };
    const end = () => { if (parts) { tokens.push({ type: "word", parts, raw, line: wordLine }); parts = null; } };
    const op = value => { end(); tokens.push({ type: "op", value, line }); };

    let i = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === " " || c === "\t" || c === "\r") { end(); i++; continue; }
      if (c === "\n") { end(); tokens.push({ type: "nl", line }); line++; i++; continue; }
      if (c === "#" && !parts) { while (i < src.length && src[i] !== "\n") i++; continue; }
      if (c === "\\") {
        if (src[i + 1] === "\n") { i += 2; line++; continue; }
        if (i + 1 >= src.length) throw new ShellSyntaxError("unexpected end of input after '\\'", true, line);
        lit(src[i + 1], 1); raw += src.slice(i, i + 2); i += 2; continue;
      }
      if (c === "'") {
        const close = src.indexOf("'", i + 1);
        if (close < 0) throw new ShellSyntaxError("unexpected end of input while looking for matching '''", true, line);
        lit(src.slice(i + 1, close), 1);
        raw += src.slice(i, close + 1);
        line += (src.slice(i, close).match(/\n/g) || []).length;
        i = close + 1; continue;
      }
      if (c === '"') {
        start();
        let j = i + 1;
        const partsBefore = parts.length;
        const lastBefore = parts[partsBefore - 1];
        const lengthBefore = lastBefore && lastBefore.t === "lit" ? lastBefore.v.length : -1;
        while (true) {
          if (j >= src.length) throw new ShellSyntaxError("unexpected end of input while looking for matching '\"'", true, line);
          const d = src[j];
          if (d === '"') { j++; break; }
          if (d === "\\" && j + 1 < src.length && '$`"\\\n'.includes(src[j + 1])) {
            if (src[j + 1] !== "\n") lit(src[j + 1], 2);
            j += 2; continue;
          }
          if (d === "$") {
            const read = readDollar(src, j, 2, line);
            if (read) { parts.push(read.part); j = read.end; continue; }
          }
          if (d === "\n") line++;
          lit(d, 2); j++;
        }
        // "" is still a word (an empty argument), but "$@" with no arguments is not.
        const grew = parts.length > partsBefore || (lastBefore && lastBefore.t === "lit" && lastBefore.v.length > lengthBefore);
        if (!grew) parts.push({ t: "lit", v: "", q: 2 });
        raw += src.slice(i, j);
        i = j; continue;
      }
      if (c === "$") {
        const read = readDollar(src, i, 0, line);
        if (read) { start(); parts.push(read.part); raw += src.slice(i, read.end); i = read.end; continue; }
      }
      if (!parts && c === "2" && src[i + 1] === ">") {
        if (src.startsWith("2>&1", i)) { op("2>&1"); i += 4; continue; }
        if (src[i + 2] === ">") { op("2>>"); i += 3; continue; }
        op("2>"); i += 2; continue;
      }
      if (c === "&" && src[i + 1] === ">") { op("&>"); i += 2; continue; }
      const two = src.slice(i, i + 2);
      if (two === "&&" || two === "||" || two === ";;" || two === ">>") { op(two); i += 2; continue; }
      if (c === "|" || c === ";" || c === ">" || c === "<" || c === "&") { op(c); i++; continue; }
      lit(c, 0); raw += c; i++;
    }
    end();
    return tokens;
  }

  // ------------------------------------------------------------------- parser
  const plain = token => token && token.type === "word" && token.parts.length === 1 && token.parts[0].t === "lit" && token.parts[0].q === 0 ? token.parts[0].v : null;
  const describe = token => !token ? "end of input" : token.type === "nl" ? "newline" : token.type === "op" ? token.value : token.raw;

  class Parser {
    constructor(tokens) { this.tokens = tokens; this.i = 0; }
    peek() { return this.tokens[this.i]; }
    next() { return this.tokens[this.i++]; }
    isOp(value) { const t = this.peek(); return !!t && t.type === "op" && t.value === value; }
    isWord(text) { return plain(this.peek()) === text; }
    lastLine() { const t = this.tokens[Math.min(this.i, this.tokens.length - 1)]; return t ? t.line : 1; }
    fail(token) {
      if (!token) throw new ShellSyntaxError("syntax error: unexpected end of input", true, this.lastLine());
      throw new ShellSyntaxError(`syntax error near unexpected token '${describe(token)}'`, false, token.line);
    }
    skipNewlines() { while (this.peek() && this.peek().type === "nl") this.i++; }
    skipSeparators() { while (this.peek() && (this.peek().type === "nl" || this.isOp(";"))) this.i++; }
    expect(text) { const t = this.peek(); if (plain(t) === text) { this.i++; return; } this.fail(t); }

    program() {
      const list = this.list([]);
      if (this.peek()) this.fail(this.peek());
      return list;
    }
    list(stops) {
      const items = [];
      for (;;) {
        this.skipSeparators();
        const t = this.peek();
        if (!t || stops.includes(plain(t)) || this.isOp(";;")) break;
        items.push(this.andOr());
        const s = this.peek();
        if (!s || s.type === "nl" || this.isOp(";") || this.isOp(";;") || stops.includes(plain(s))) continue;
        if (this.isOp("&")) throw new ShellSyntaxError("background jobs (&) are not supported", false, s.line);
        this.fail(s);
      }
      return { type: "list", items };
    }
    andOr() {
      const first = this.pipeline();
      const rest = [];
      while (this.isOp("&&") || this.isOp("||")) {
        const op = this.next().value;
        this.skipNewlines();
        rest.push({ op, pipeline: this.pipeline() });
      }
      return { type: "andor", first, rest };
    }
    pipeline() {
      let negate = false;
      if (this.isWord("!")) { this.i++; negate = true; }
      const cmds = [this.command()];
      while (this.isOp("|")) { this.i++; this.skipNewlines(); cmds.push(this.command()); }
      return { type: "pipeline", negate, cmds };
    }
    command() {
      const t = this.peek();
      if (!t) this.fail(t);
      if (t.type === "op" && !REDIRECTS.has(t.value)) this.fail(t);
      const w = plain(t);
      let node;
      if (w === "if") node = this.ifClause();
      else if (w === "for") node = this.forClause();
      else if (w === "while" || w === "until") node = this.whileClause();
      else if (w === "case") node = this.caseClause();
      else if (w === "{") node = this.group();
      else if (w === "function") node = this.functionDef(true);
      else if (w && /^[A-Za-z_][\w.-]*\(\)$/.test(w)) node = this.functionDef(false);
      else if (w && NAME_RE.test(w) && plain(this.tokens[this.i + 1]) === "()") node = this.functionDef(false);
      else if (w && RESERVED.has(w)) this.fail(t);
      else return this.simple();
      node.redirs = this.redirects();
      return node;
    }
    redirects() {
      const redirs = [];
      while (this.peek() && this.peek().type === "op" && REDIRECTS.has(this.peek().value)) redirs.push(this.redirect());
      return redirs;
    }
    redirect() {
      const op = this.next().value;
      if (op === "2>&1") return { op };
      const target = this.next();
      if (!target || target.type !== "word") this.fail(target);
      return { op, target };
    }
    simple() {
      const assigns = [], words = [], redirs = [];
      for (;;) {
        const t = this.peek();
        if (!t || t.type === "nl") break;
        if (t.type === "op") { if (REDIRECTS.has(t.value)) { redirs.push(this.redirect()); continue; } break; }
        const first = t.parts[0];
        if (!words.length && first.t === "lit" && first.q === 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(first.v)) {
          const eq = first.v.indexOf("=");
          const rest = first.v.slice(eq + 1);
          const parts = (rest ? [{ t: "lit", v: rest, q: 0 }] : []).concat(t.parts.slice(1));
          assigns.push({ name: first.v.slice(0, eq), word: { type: "word", parts, raw: t.raw.slice(eq + 1) } });
          this.i++; continue;
        }
        words.push(this.next());
      }
      if (!assigns.length && !words.length && !redirs.length) this.fail(this.peek());
      return { type: "simple", assigns, words, redirs, line: (words[0] || {}).line };
    }
    ifClause() {
      this.i++;
      const clauses = [];
      let elseBody = null;
      let cond = this.list(["then"]); this.expect("then");
      clauses.push({ cond, body: this.list(["elif", "else", "fi"]) });
      for (;;) {
        const w = plain(this.peek());
        if (w === "elif") { this.i++; cond = this.list(["then"]); this.expect("then"); clauses.push({ cond, body: this.list(["elif", "else", "fi"]) }); }
        else if (w === "else") { this.i++; elseBody = this.list(["fi"]); this.expect("fi"); break; }
        else if (w === "fi") { this.i++; break; }
        else this.fail(this.peek());
      }
      return { type: "if", clauses, elseBody };
    }
    forClause() {
      this.i++;
      const nameToken = this.next();
      const name = plain(nameToken);
      if (!name || !NAME_RE.test(name)) this.fail(nameToken);
      let words = null;
      this.skipNewlines();
      if (this.isWord("in")) {
        this.i++;
        words = [];
        while (this.peek() && this.peek().type === "word") words.push(this.next());
      }
      if (this.isOp(";")) this.i++;
      this.skipNewlines();
      this.expect("do");
      const body = this.list(["done"]); this.expect("done");
      return { type: "for", name, words, body };
    }
    whileClause() {
      const until = plain(this.next()) === "until";
      const cond = this.list(["do"]); this.expect("do");
      const body = this.list(["done"]); this.expect("done");
      return { type: "while", until, cond, body };
    }
    caseClause() {
      this.i++;
      const subject = this.next();
      if (!subject || subject.type !== "word") this.fail(subject);
      this.skipNewlines();
      this.expect("in");
      const items = [];
      for (;;) {
        this.skipSeparators();
        const t = this.peek();
        if (!t) this.fail(t);
        if (plain(t) === "esac") { this.i++; break; }
        const patterns = [];
        if (plain(t) === "(") this.i++;
        for (;;) {
          const p = this.next();
          if (!p || p.type !== "word") this.fail(p);
          const last = p.parts[p.parts.length - 1];
          if (last.t === "lit" && last.q === 0 && last.v.endsWith(")")) {
            const parts = p.parts.slice(0, -1);
            if (last.v.length > 1) parts.push({ t: "lit", v: last.v.slice(0, -1), q: 0 });
            patterns.push({ type: "word", parts, raw: p.raw.slice(0, -1) });
            break;
          }
          patterns.push(p);
          if (!this.isOp("|")) {
            if (plain(this.peek()) === ")") { this.i++; break; }
            this.fail(this.peek());
          }
          this.i++;
        }
        const body = this.list(["esac"]);
        items.push({ patterns, body });
        if (this.isOp(";;")) this.i++;
      }
      return { type: "case", subject, items };
    }
    group() {
      this.i++;
      const body = this.list(["}"]); this.expect("}");
      return { type: "group", body };
    }
    functionDef(keyword) {
      let name;
      if (keyword) {
        this.i++;
        name = plain(this.next());
        if (this.isWord("()")) this.i++;
      } else {
        const w = plain(this.next());
        name = w.endsWith("()") ? w.slice(0, -2) : w;
        if (this.isWord("()")) this.i++;
      }
      if (!name || !/^[A-Za-z_][\w.-]*$/.test(name)) this.fail(this.tokens[this.i - 1]);
      this.skipNewlines();
      const body = this.command();
      return { type: "function", name, body };
    }
  }

  function parse(source) {
    return new Parser(tokenize(String(source))).program();
  }

  // --------------------------------------------------------------- arithmetic
  // Integers like a POSIX shell: + - * / % ** comparisons && || ! and parentheses.
  // Bare names are variables (i+1 is the same as $i+1).
  function arithmetic(expression, lookup) {
    const tokens = String(expression).match(/\s*(\d+|[A-Za-z_][A-Za-z0-9_]*|\*\*|<=|>=|==|!=|&&|\|\||[-+*/%()<>!])\s*/g);
    const compact = String(expression).replace(/\s+/g, "");
    if (!compact) return 0;
    if (!tokens || tokens.join("").replace(/\s+/g, "") !== compact) throw new Error(`${expression.trim()}: syntax error in expression`);
    const list = tokens.map(t => t.trim());
    let pos = 0;
    const peek = () => list[pos];
    const take = () => list[pos++];
    const BINARY = { "||": 1, "&&": 2, "==": 3, "!=": 3, "<": 4, ">": 4, "<=": 4, ">=": 4, "+": 5, "-": 5, "*": 6, "/": 6, "%": 6, "**": 7 };
    const unary = () => {
      const t = take();
      if (t === undefined) throw new Error("syntax error: operand expected");
      if (t === "-") return -unary();
      if (t === "+") return +unary();
      if (t === "!") return unary() ? 0 : 1;
      if (t === "(") { const value = binary(0); if (take() !== ")") throw new Error("syntax error: ')' expected"); return value; }
      if (/^\d+$/.test(t)) return parseInt(t, 10);
      if (NAME_RE.test(t)) { const v = parseInt(lookup(t), 10); return Number.isFinite(v) ? v : 0; }
      throw new Error(`syntax error: operand expected (error token is "${t}")`);
    };
    const binary = minPrec => {
      let left = unary();
      for (;;) {
        const op = peek();
        const prec = BINARY[op];
        if (!prec || prec < minPrec) return left;
        take();
        const right = binary(op === "**" ? prec : prec + 1);
        switch (op) {
          case "+": left = left + right; break;
          case "-": left = left - right; break;
          case "*": left = left * right; break;
          case "/": if (right === 0) throw new Error("division by 0"); left = Math.trunc(left / right); break;
          case "%": if (right === 0) throw new Error("division by 0"); left = left % right; break;
          case "**": left = Math.pow(left, right); break;
          case "<": left = left < right ? 1 : 0; break;
          case ">": left = left > right ? 1 : 0; break;
          case "<=": left = left <= right ? 1 : 0; break;
          case ">=": left = left >= right ? 1 : 0; break;
          case "==": left = left === right ? 1 : 0; break;
          case "!=": left = left !== right ? 1 : 0; break;
          case "&&": left = left && right ? 1 : 0; break;
          case "||": left = left || right ? 1 : 0; break;
        }
      }
    };
    const value = binary(1);
    if (pos < list.length) throw new Error(`syntax error in expression (error token is "${list[pos]}")`);
    return value;
  }

  // ----------------------------------------------------------------- patterns
  function globToRegExp(pattern, { anchored = true, greedy = true } = {}) {
    let out = "";
    for (let i = 0; i < pattern.length; i++) {
      const c = pattern[i];
      if (c === "\\" && i + 1 < pattern.length) { out += pattern[++i].replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"); continue; }
      if (c === "*") out += greedy ? ".*" : ".*?";
      else if (c === "?") out += ".";
      else if (c === "[") {
        const close = pattern.indexOf("]", i + 2);
        if (close < 0) { out += "\\["; continue; }
        let set = pattern.slice(i + 1, close);
        if (set[0] === "!") set = "^" + set.slice(1);
        out += `[${set.replace(/\\/g, "\\\\")}]`;
        i = close;
      } else out += c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    }
    return new RegExp(anchored ? `^${out}$` : out, "s");
  }
  const escapeGlob = text => text.replace(/[*?[\]\\]/g, "\\$&");
  const hasGlob = text => /[*?]|\[[^\]]+\]/.test(text);

  // ----------------------------------------------------------------- the shell
  const makeInput = text => ({ text: String(text) });

  class Shell {
    constructor(host, options = {}) {
      this.host = host;
      this.vars = new Map(Object.entries(options.env || {}));
      this.scopes = [];
      this.functions = options.functions || new Map();
      this.aliases = options.aliases || new Map();
      this.positional = options.args || [];
      this.name = options.name || "mwsh";
      this.interactive = !!options.interactive;
      this.options = { errexit: false, xtrace: false, ...(options.options || {}) };
      this.status = 0;
      this.depth = options.depth || 0;
      this.condDepth = 0;
      this.loopDepth = 0;
      this.steps = 0;
      this.started = Date.now();
    }

    child(args, name) {
      return new Shell(this.host, {
        env: Object.fromEntries(this.vars),
        functions: new Map(this.functions),
        aliases: new Map(this.aliases),
        args, name, depth: this.depth + 1,
        options: { ...this.options, errexit: false, xtrace: false }
      });
    }

    // --- variables
    getVar(name) {
      switch (name) {
        case "?": return String(this.status);
        case "#": return String(this.positional.length);
        case "@": case "*": return this.positional.join(" ");
        case "0": return this.name;
        case "$": return "4242";
        case "!": return "";
        case "RANDOM": return String(Math.floor(Math.random() * 32768));
        case "SECONDS": return String(Math.floor((Date.now() - this.started) / 1000));
        case "PWD": return this.host.cwd();
      }
      if (/^\d+$/.test(name)) { const v = this.positional[parseInt(name, 10) - 1]; return v === undefined ? undefined : v; }
      for (let k = this.scopes.length - 1; k >= 0; k--) if (this.scopes[k].has(name)) return this.scopes[k].get(name);
      return this.vars.has(name) ? this.vars.get(name) : undefined;
    }
    setVar(name, value) {
      if (!NAME_RE.test(name)) throw new Error(`'${name}': not a valid identifier`);
      for (let k = this.scopes.length - 1; k >= 0; k--) if (this.scopes[k].has(name)) { this.scopes[k].set(name, String(value)); return; }
      this.vars.set(name, String(value));
    }
    unsetVar(name) {
      for (let k = this.scopes.length - 1; k >= 0; k--) if (this.scopes[k].has(name)) { this.scopes[k].delete(name); return; }
      this.vars.delete(name);
    }
    environment() {
      const env = new Map(this.vars);
      this.scopes.forEach(scope => scope.forEach((v, k) => env.set(k, v)));
      env.set("PWD", this.host.cwd());
      return env;
    }

    // --- running
    async run(source, frame = null) {
      const ast = parse(source);
      return this.execList(ast, frame || { stdin: null, out: null, err: "screen" });
    }

    // Runs a script (a .mwex file, or sh FILE) in its own scope; exit only ends it.
    async runScript(source, args, name, frame) {
      if (this.depth > 40) throw new Error("maximum script nesting level exceeded");
      const shell = this.child(args, name);
      try {
        return await shell.run(source, frame);
      } catch (error) {
        if (error instanceof ExitSignal) return error.status;
        if (error instanceof ReturnSignal) return error.status;
        if (error instanceof ShellSyntaxError) {
          this.host.error(frame, `${name}: line ${error.line || 1}: ${error.message}`);
          return 2;
        }
        throw error;
      }
    }

    async tick() {
      this.steps++;
      if (this.host.interrupted()) throw new Interrupt();
      if (this.steps % 40 === 0) await this.host.yield();
    }

    async execList(list, frame) {
      let status = 0;
      for (const item of list.items) {
        this.tested = false;
        status = await this.execAndOr(item, frame);
        // set -e: stop at a failing command, unless its status was being tested.
        if (status !== 0 && this.options.errexit && this.condDepth === 0 && !this.tested) throw new ExitSignal(status);
      }
      return status;
    }

    // a && b || c: every pipeline but the last one is a test, so it never trips set -e.
    async execAndOr(node, frame) {
      const pipelines = [node.first, ...node.rest.map(item => item.pipeline)];
      let status = 0;
      let ranLast = false;
      for (let k = 0; k < pipelines.length; k++) {
        if (k > 0) {
          const op = node.rest[k - 1].op;
          if (!((op === "&&" && status === 0) || (op === "||" && status !== 0))) continue;
        }
        const last = k === pipelines.length - 1;
        if (!last) this.condDepth++;
        try { status = await this.execPipeline(pipelines[k], frame); }
        finally { if (!last) this.condDepth--; }
        ranLast = last;
      }
      this.tested = !ranLast || pipelines[pipelines.length - 1].negate;
      return status;
    }

    async execPipeline(node, frame) {
      let status;
      if (node.negate) this.condDepth++;
      try {
        if (node.cmds.length === 1) status = await this.execCommand(node.cmds[0], frame);
        else {
          let input = frame.stdin;
          for (let k = 0; k < node.cmds.length; k++) {
            const last = k === node.cmds.length - 1;
            const stage = { stdin: input, out: last ? frame.out : [], err: frame.err };
            status = await this.execCommand(node.cmds[k], stage);
            // echo -n / printf without a final newline leave the last line open (noNewline).
            if (!last) input = makeInput(stage.out.length ? stage.out.join("\n") + (stage.noNewline ? "" : "\n") : "");
          }
        }
      } finally {
        if (node.negate) this.condDepth--;
      }
      if (node.negate) status = status === 0 ? 1 : 0;
      this.status = status;
      return status;
    }

    async execCommand(node, frame) {
      await this.tick();
      const redirected = node.redirs && node.redirs.length ? await this.applyRedirects(node.redirs, frame) : null;
      const io = redirected ? redirected.frame : frame;
      let status;
      try {
        switch (node.type) {
          case "simple": status = await this.execSimple(node, io); break;
          case "if": status = await this.execIf(node, io); break;
          case "for": status = await this.execFor(node, io); break;
          case "while": status = await this.execWhile(node, io); break;
          case "case": status = await this.execCase(node, io); break;
          case "group": status = await this.execList(node.body, io); break;
          case "function": this.functions.set(node.name, node.body); status = 0; break;
          default: throw new Error(`unknown node ${node.type}`);
        }
      } finally {
        if (redirected) await redirected.finish();
      }
      this.status = status;
      return status;
    }

    async applyRedirects(redirs, parent) {
      const frame = { stdin: parent.stdin, out: parent.out, err: parent.err };
      const writes = [];
      for (const redir of redirs) {
        if (redir.op === "2>&1") { frame.err = "out"; continue; }
        const target = (await this.expandWord(redir.target, parent, { split: false, glob: false })).join(" ");
        if (!target) throw new Error("ambiguous redirect");
        const toNull = target === "/dev/null";
        if (redir.op === "<") {
          frame.stdin = makeInput(toNull ? "" : await this.host.readFile(target));
        } else if (redir.op === ">" || redir.op === ">>" || redir.op === "&>") {
          frame.out = [];
          if (redir.op === "&>") frame.err = "out";
          if (!toNull) writes.push({ path: target, append: redir.op === ">>", stream: "out" });
          else if (redir.op === "&>") frame.err = "null";
        } else if (redir.op === "2>" || redir.op === "2>>") {
          if (toNull) frame.err = "null";
          else { frame.err = []; writes.push({ path: target, append: redir.op === "2>>", stream: "err" }); }
        }
      }
      // Create/truncate the targets first, like a shell does before running the command.
      for (const w of writes) if (!w.append) await this.host.writeFile(w.path, "", false);
      return {
        frame,
        finish: async () => {
          for (const w of writes) {
            const lines = w.stream === "out" ? frame.out : frame.err;
            const text = lines.length ? lines.join("\n") + (w.stream === "out" && frame.noNewline ? "" : "\n") : "";
            if (text || w.append) await this.host.writeFile(w.path, text, true);
          }
        }
      };
    }

    async execSimple(node, frame) {
      let argv = [];
      for (const word of node.words) argv.push(...await this.expandWord(word, frame));
      // Aliases: the first word is replaced by the alias text (once per name).
      const seen = new Set();
      while (argv.length && this.aliases.has(argv[0]) && !seen.has(argv[0]) && node.words.length && plain(node.words[0]) !== null) {
        seen.add(argv[0]);
        const words = tokenize(this.aliases.get(argv[0])).filter(t => t.type === "word");
        const expanded = [];
        for (const word of words) expanded.push(...await this.expandWord(word, frame));
        argv = expanded.concat(argv.slice(1));
      }
      const assigns = [];
      for (const a of node.assigns) assigns.push([a.name, (await this.expandWord(a.word, frame, { split: false, glob: false })).join("")]);
      if (!argv.length) {
        assigns.forEach(([k, v]) => this.setVar(k, v));
        return 0;
      }
      if (this.options.xtrace) this.host.error(frame, `+ ${argv.map(quoteArg).join(" ")}`);
      if (!assigns.length) return this.invoke(argv, frame);
      // VAR=value command: the variables only last for that command.
      const saved = assigns.map(([k]) => [k, this.vars.has(k) ? this.vars.get(k) : undefined]);
      assigns.forEach(([k, v]) => this.vars.set(k, v));
      try { return await this.invoke(argv, frame); }
      finally { saved.forEach(([k, v]) => v === undefined ? this.vars.delete(k) : this.vars.set(k, v)); }
    }

    async invoke(argv, frame) {
      const name = argv[0];
      try {
        if (this.functions.has(name)) return await this.callFunction(name, argv.slice(1), frame);
        if (Object.prototype.hasOwnProperty.call(BUILTINS, name)) return await BUILTINS[name].call(this, argv, frame);
        const status = await this.host.exec(argv, frame, this);
        return typeof status === "number" ? status : 0;
      } catch (error) {
        if (error instanceof ExitSignal || error instanceof ReturnSignal || error instanceof LoopSignal || error instanceof Interrupt) throw error;
        if (error instanceof ShellSyntaxError) { this.host.error(frame, `${name}: ${error.message}`); return 2; }
        this.host.error(frame, `${name}: ${error && error.message ? error.message : error}`);
        return error && Number.isInteger(error.status) ? error.status : 1;
      }
    }

    async callFunction(name, args, frame) {
      if (this.depth + this.scopes.length > 200) throw new Error("maximum function nesting level exceeded");
      const saved = this.positional;
      this.positional = args;
      this.scopes.push(new Map());
      try {
        return await this.execCommand(this.functions.get(name), frame);
      } catch (error) {
        if (error instanceof ReturnSignal) return error.status;
        throw error;
      } finally {
        this.scopes.pop();
        this.positional = saved;
      }
    }

    async condition(list, frame) {
      this.condDepth++;
      try { return await this.execList(list, frame); } finally { this.condDepth--; }
    }

    async execIf(node, frame) {
      for (const clause of node.clauses) {
        if (await this.condition(clause.cond, frame) === 0) return this.execList(clause.body, frame);
      }
      return node.elseBody ? this.execList(node.elseBody, frame) : 0;
    }

    async loopBody(body, frame) {
      try {
        return { status: await this.execList(body, frame) };
      } catch (error) {
        if (!(error instanceof LoopSignal)) throw error;
        if (error.levels > 1) { error.levels--; throw error; }
        return { status: 0, signal: error.kind };
      }
    }

    async execFor(node, frame) {
      let values;
      if (node.words) {
        values = [];
        for (const word of node.words) values.push(...await this.expandWord(word, frame));
      } else values = this.positional.slice();
      let status = 0;
      this.loopDepth++;
      try {
        for (const value of values) {
          await this.tick();
          this.setVar(node.name, value);
          const result = await this.loopBody(node.body, frame);
          status = result.status;
          if (result.signal === "break") break;
        }
      } finally { this.loopDepth--; }
      return status;
    }

    async execWhile(node, frame) {
      let status = 0;
      this.loopDepth++;
      try {
        for (;;) {
          await this.tick();
          const cond = await this.condition(node.cond, frame);
          if (node.until ? cond === 0 : cond !== 0) break;
          const result = await this.loopBody(node.body, frame);
          status = result.status;
          if (result.signal === "break") break;
        }
      } finally { this.loopDepth--; }
      return status;
    }

    async execCase(node, frame) {
      const subject = (await this.expandWord(node.subject, frame, { split: false, glob: false })).join("");
      for (const item of node.items) {
        for (const pattern of item.patterns) {
          const text = await this.expandPattern(pattern, frame);
          if (globToRegExp(text).test(subject)) return this.execList(item.body, frame);
        }
      }
      return 0;
    }

    // --- expansion
    async paramValue(part, frame) {
      const { name, op, arg } = part;
      let value = this.getVar(name);
      if (name === "@" || name === "*") value = this.positional.length ? this.positional.join(" ") : undefined;
      const argument = async () => this.expandText(arg, frame);
      switch (op) {
        case "len": return String((value || "").length);
        case ":-": return value ? value : await argument();
        case "-": return value !== undefined ? value : await argument();
        case ":=": case "=": {
          if (op === ":=" ? !value : value === undefined) { value = await argument(); this.setVar(name, value); }
          return value;
        }
        case ":+": return value ? await argument() : "";
        case "+": return value !== undefined ? await argument() : "";
        case ":?": if (!value) throw new Error(`${name}: ${(await argument()) || "parameter null or not set"}`); return value;
        case "#": case "##": case "%": case "%%": {
          const text = value || "";
          const pattern = await argument();
          const greedy = op.length === 2;
          if (op[0] === "#") {
            for (let k = greedy ? text.length : 0; greedy ? k >= 0 : k <= text.length; greedy ? k-- : k++) {
              if (globToRegExp(pattern).test(text.slice(0, k))) return text.slice(k);
            }
          } else {
            for (let k = greedy ? 0 : text.length; greedy ? k <= text.length : k >= 0; greedy ? k++ : k--) {
              if (globToRegExp(pattern).test(text.slice(k))) return text.slice(0, k);
            }
          }
          return text;
        }
        case "/": case "//": {
          const slash = arg.indexOf("/");
          const from = await this.expandText(slash < 0 ? arg : arg.slice(0, slash), frame);
          const to = slash < 0 ? "" : await this.expandText(arg.slice(slash + 1), frame);
          if (!from) return value || "";
          const re = new RegExp(globToRegExp(from, { anchored: false }).source, op === "//" ? "gs" : "s");
          return (value || "").replace(re, () => to);
        }
        default: return value === undefined ? "" : value;
      }
    }

    // Expands text as if it were inside double quotes (used by ${x:-...} and $((...))).
    async expandText(text, frame) {
      if (!text) return "";
      const tokens = tokenize(`"${String(text).replace(/(["\\])/g, "\\$1")}"`);
      if (!tokens.length) return "";
      return (await this.expandWord(tokens[0], frame, { split: false, glob: false })).join("");
    }

    async expandPattern(word, frame) {
      let out = "";
      for (const part of word.parts) {
        if (part.t === "lit") out += part.q ? escapeGlob(part.v) : part.v;
        else out += part.q ? escapeGlob(await this.partValue(part, frame)) : await this.partValue(part, frame);
      }
      return out;
    }

    async partValue(part, frame) {
      if (part.t === "param") return this.paramValue(part, frame);
      if (part.t === "cmd") return this.capture(part.src, frame);
      if (part.t === "arith") {
        const expression = await this.expandText(part.src, frame);
        return String(arithmetic(expression, name => this.getVar(name)));
      }
      return part.v;
    }

    // $(command): run it with stdout captured; trailing newlines are dropped.
    async capture(source, frame) {
      const sub = { stdin: null, out: [], err: frame ? frame.err : "screen" };
      try {
        this.status = await this.run(source, sub);
      } catch (error) {
        if (error instanceof ExitSignal) this.status = error.status;
        else throw error;
      }
      return sub.out.join("\n").replace(/\n+$/, "");
    }

    // Returns the fields a word becomes: variables split on whitespace when unquoted,
    // "$@" keeps one field per argument, unquoted * and ? match files.
    async expandWord(word, frame, { split = true, glob = true } = {}) {
      const fields = [];
      let cur = null;
      const ensure = () => cur || (cur = { text: "", pattern: "", quoted: false, glob: false });
      const flush = () => { if (cur) fields.push(cur); cur = null; };
      const add = (text, quoted) => {
        ensure();
        cur.text += text;
        cur.pattern += quoted ? escapeGlob(text) : text;
        if (quoted) cur.quoted = true;
        else if (hasGlob(text)) cur.glob = true;
      };
      const addSplit = text => {
        if (!split) { add(text, false); return; }
        if (!text) return;
        const pieces = text.split(/[ \t\n]+/);
        pieces.forEach((piece, k) => {
          if (k > 0) flush();
          if (piece) add(piece, false);
        });
      };

      for (let k = 0; k < word.parts.length; k++) {
        const part = word.parts[k];
        if (part.t === "lit") {
          let text = part.v;
          if (k === 0 && part.q === 0 && /^~(?=\/|$)/.test(text)) text = (this.getVar("HOME") || "/home") + text.slice(1);
          add(text, part.q !== 0);
        } else if (part.t === "param" && (part.name === "@" || part.name === "*") && !part.op) {
          if (part.q === 2 && part.name === "@") {
            this.positional.forEach((arg, n) => { if (n > 0) flush(); add(arg, true); });
          } else if (part.q === 2) add(this.positional.join(" "), true);
          else this.positional.forEach(arg => { flush(); addSplit(arg); });
        } else {
          const value = await this.partValue(part, frame);
          if (part.q === 2) add(value, true);
          else addSplit(value);
        }
      }
      flush();
      const result = [];
      for (const field of fields) {
        if (!field.text && !field.quoted) continue;
        if (glob && field.glob && this.host.glob) {
          const matches = await this.host.glob(field.pattern);
          if (matches && matches.length) { result.push(...matches); continue; }
        }
        result.push(field.text);
      }
      return result;
    }
  }

  function quoteArg(arg) {
    return /^[\w@%+=:,./~-]+$/.test(arg) ? arg : `'${String(arg).replace(/'/g, `'\\''`)}'`;
  }

  // ----------------------------------------------------------------- builtins
  // test / [ : file checks go through host.stat.
  async function evaluateTest(shell, args) {
    let pos = 0;
    const UNARY = new Set(["-e", "-f", "-d", "-s", "-r", "-w", "-x", "-z", "-n", "-L", "-h"]);
    const BINARY = new Set(["=", "==", "!=", "<", ">", "-eq", "-ne", "-lt", "-le", "-gt", "-ge", "-nt", "-ot"]);
    const num = value => {
      if (!/^\s*-?\d+\s*$/.test(value)) throw new Error(`${value}: integer expression expected`);
      return parseInt(value, 10);
    };
    const primary = async () => {
      const a = args[pos];
      if (a === undefined) throw new Error("argument expected");
      if (a === "!") { pos++; return !(await primary()); }
      if (a === "(") { pos++; const value = await or(); if (args[pos++] !== ")") throw new Error("')' expected"); return value; }
      if (BINARY.has(args[pos + 1]) && pos + 2 < args.length) {
        const left = args[pos], op = args[pos + 1], right = args[pos + 2];
        pos += 3;
        switch (op) {
          case "=": case "==": return left === right;
          case "!=": return left !== right;
          case "<": return left < right;
          case ">": return left > right;
          case "-eq": return num(left) === num(right);
          case "-ne": return num(left) !== num(right);
          case "-lt": return num(left) < num(right);
          case "-le": return num(left) <= num(right);
          case "-gt": return num(left) > num(right);
          case "-ge": return num(left) >= num(right);
          default: return false;
        }
      }
      if (UNARY.has(a) && pos + 1 < args.length) {
        const operand = args[pos + 1];
        pos += 2;
        if (a === "-z") return operand.length === 0;
        if (a === "-n") return operand.length > 0;
        const info = await shell.host.stat(operand);
        if (!info) return false;
        switch (a) {
          case "-d": return info.type === "folder";
          case "-f": return info.type !== "folder";
          case "-s": return info.type !== "folder" && (info.bytes || 0) > 0;
          case "-x": return info.type === "folder" || /\.mwex$/i.test(operand);
          case "-L": case "-h": return false;
          default: return true;
        }
      }
      pos++;
      return a.length > 0;
    };
    const and = async () => { let value = await primary(); while (args[pos] === "-a") { pos++; const right = await primary(); value = value && right; } return value; };
    const or = async () => { let value = await and(); while (args[pos] === "-o") { pos++; const right = await and(); value = value || right; } return value; };
    if (!args.length) return false;
    const value = await or();
    if (pos < args.length) throw new Error(`${args[pos]}: unexpected argument`);
    return value;
  }

  function parseCount(arg, fallback = 1) {
    if (arg === undefined) return fallback;
    if (!/^\d+$/.test(arg)) throw new Error(`${arg}: numeric argument required`);
    return parseInt(arg, 10);
  }

  function takeLine(stdin) {
    if (!stdin || !stdin.text) return null;
    const nl = stdin.text.indexOf("\n");
    const line = nl < 0 ? stdin.text : stdin.text.slice(0, nl);
    stdin.text = nl < 0 ? "" : stdin.text.slice(nl + 1);
    return line;
  }

  async function readSource(shell, file) {
    const text = await shell.host.readFile(file);
    return text.replace(/^\uFEFF/, "");
  }

  const BUILTINS = {
    ":": async () => 0,
    true: async () => 0,
    false: async () => 1,

    async exit(argv) {
      const status = argv[1] === undefined ? this.status : parseCount(argv[1]) & 255;
      if (this.interactive && this.depth === 0) this.host.closeShell();
      throw new ExitSignal(status);
    },
    async return(argv) {
      throw new ReturnSignal(argv[1] === undefined ? this.status : parseCount(argv[1]) & 255);
    },
    async break(argv) {
      if (!this.loopDepth) throw new Error("only meaningful in a 'for', 'while', or 'until' loop");
      throw new LoopSignal("break", parseCount(argv[1]));
    },
    async continue(argv) {
      if (!this.loopDepth) throw new Error("only meaningful in a 'for', 'while', or 'until' loop");
      throw new LoopSignal("continue", parseCount(argv[1]));
    },
    async shift(argv) {
      const n = parseCount(argv[1]);
      if (n > this.positional.length) return 1;
      this.positional = this.positional.slice(n);
      return 0;
    },

    async export(argv, frame) {
      if (argv.length === 1 || argv[1] === "-p") {
        [...this.environment()].sort(([a], [b]) => a.localeCompare(b)).forEach(([k, v]) => this.host.write(frame, `export ${k}=${quoteArg(v)}`));
        return 0;
      }
      for (const arg of argv.slice(1)) {
        const eq = arg.indexOf("=");
        if (eq < 0) { if (!NAME_RE.test(arg)) throw new Error(`'${arg}': not a valid identifier`); if (this.getVar(arg) === undefined) this.setVar(arg, ""); continue; }
        this.setVar(arg.slice(0, eq), arg.slice(eq + 1));
      }
      return 0;
    },
    async local(argv) {
      if (!this.scopes.length) throw new Error("can only be used in a function");
      const scope = this.scopes[this.scopes.length - 1];
      for (const arg of argv.slice(1)) {
        const eq = arg.indexOf("=");
        const name = eq < 0 ? arg : arg.slice(0, eq);
        if (!NAME_RE.test(name)) throw new Error(`'${name}': not a valid identifier`);
        scope.set(name, eq < 0 ? "" : arg.slice(eq + 1));
      }
      return 0;
    },
    async unset(argv) {
      for (const name of argv.slice(1)) {
        if (name === "-f" || name === "-v") continue;
        if (argv[1] === "-f") this.functions.delete(name);
        else this.unsetVar(name);
      }
      return 0;
    },
    async set(argv, frame) {
      if (argv.length === 1) {
        [...this.environment()].sort(([a], [b]) => a.localeCompare(b)).forEach(([k, v]) => this.host.write(frame, `${k}=${quoteArg(v)}`));
        return 0;
      }
      for (let k = 1; k < argv.length; k++) {
        const arg = argv[k];
        if (arg === "--") { this.positional = argv.slice(k + 1); return 0; }
        const on = arg[0] === "-";
        if (!/^[-+][ex]+$/.test(arg)) throw new Error(`${arg}: invalid option (use -e, -x, +e, +x or --)`);
        for (const flag of arg.slice(1)) {
          if (flag === "e") this.options.errexit = on;
          if (flag === "x") this.options.xtrace = on;
        }
      }
      return 0;
    },
    async env(argv, frame) {
      if (argv.length > 1) return this.invoke(argv.slice(1), frame);
      [...this.environment()].sort(([a], [b]) => a.localeCompare(b)).forEach(([k, v]) => this.host.write(frame, `${k}=${v}`));
      return 0;
    },
    async printenv(argv, frame) {
      if (argv.length === 1) return BUILTINS.env.call(this, argv, frame);
      let status = 0;
      for (const name of argv.slice(1)) {
        const value = this.environment().get(name);
        if (value === undefined) status = 1; else this.host.write(frame, value);
      }
      return status;
    },

    async alias(argv, frame) {
      if (argv.length === 1) {
        [...this.aliases].sort(([a], [b]) => a.localeCompare(b)).forEach(([k, v]) => this.host.write(frame, `alias ${k}=${quoteArg(v)}`));
        return 0;
      }
      let status = 0;
      for (const arg of argv.slice(1)) {
        const eq = arg.indexOf("=");
        if (eq < 0) {
          if (this.aliases.has(arg)) this.host.write(frame, `alias ${arg}=${quoteArg(this.aliases.get(arg))}`);
          else { this.host.error(frame, `alias: ${arg}: not found`); status = 1; }
          continue;
        }
        const name = arg.slice(0, eq);
        if (!/^[\w.@%+:-]+$/.test(name)) throw new Error(`'${name}': invalid alias name`);
        this.aliases.set(name, arg.slice(eq + 1));
      }
      return status;
    },
    async unalias(argv) {
      if (argv[1] === "-a") { this.aliases.clear(); return 0; }
      let status = 0;
      for (const name of argv.slice(1)) if (!this.aliases.delete(name)) { this.host.error(null, `unalias: ${name}: not found`); status = 1; }
      return status;
    },

    async read(argv, frame) {
      let prompt = "", secret = false;
      const names = [];
      for (let k = 1; k < argv.length; k++) {
        if (argv[k] === "-p") prompt = argv[++k] || "";
        else if (argv[k] === "-s") secret = true;
        else if (argv[k] === "-r") continue;
        else names.push(argv[k]);
      }
      if (!names.length) names.push("REPLY");
      let line;
      if (frame.stdin) {
        line = takeLine(frame.stdin);
        if (line === null) return 1;
      } else {
        line = await this.host.readLine(prompt, { secret });
      }
      const fields = names.length === 1 ? [line.replace(/^\s+|\s+$/g, "")] : line.trim().split(/\s+/);
      names.forEach((name, k) => {
        const value = k === names.length - 1 ? fields.slice(k).join(" ") : (fields[k] || "");
        this.setVar(name, value);
      });
      return 0;
    },

    async test(argv) { return (await evaluateTest(this, argv.slice(1))) ? 0 : 1; },
    async "["(argv) {
      if (argv[argv.length - 1] !== "]") throw new Error("missing ']'");
      return (await evaluateTest(this, argv.slice(1, -1))) ? 0 : 1;
    },

    async eval(argv, frame) {
      return this.run(argv.slice(1).join(" "), frame);
    },
    async source(argv, frame) {
      if (!argv[1]) throw new Error("filename argument required");
      const text = await readSource(this, argv[1]);
      const saved = this.positional;
      if (argv.length > 2) this.positional = argv.slice(2);
      try {
        return await this.run(text, frame);
      } catch (error) {
        if (error instanceof ReturnSignal) return error.status;
        if (error instanceof ShellSyntaxError) { this.host.error(frame, `${argv[1]}: line ${error.line || 1}: ${error.message}`); return 2; }
        throw error;
      } finally {
        this.positional = saved;
      }
    },
    async sh(argv, frame) {
      if (argv[1] === "-c") {
        if (argv[2] === undefined) throw new Error("-c: option requires an argument");
        const shell = this.child(argv.slice(4), argv[3] || "sh");
        try { return await shell.run(argv[2], frame); }
        catch (error) { if (error instanceof ExitSignal) return error.status; throw error; }
      }
      if (!argv[1]) throw new Error("usage: sh <script.mwex> [arguments...] | sh -c '<commands>'");
      const text = await readSource(this, argv[1]);
      return this.runScript(text, argv.slice(2), argv[1], frame);
    },

    async type(argv, frame) {
      let status = 0;
      for (const name of argv.slice(1)) {
        if (this.aliases.has(name)) this.host.write(frame, `${name} is aliased to '${this.aliases.get(name)}'`);
        else if (this.functions.has(name)) this.host.write(frame, `${name} is a function`);
        else if (Object.prototype.hasOwnProperty.call(BUILTINS, name)) this.host.write(frame, `${name} is a shell builtin`);
        else {
          const found = await this.host.which(name, this);
          if (found && found.kind === "script") this.host.write(frame, `${name} is ${found.path}`);
          else if (found) this.host.write(frame, `${name} is a terminal command`);
          else { this.host.error(frame, `type: ${name}: not found`); status = 1; }
        }
      }
      return status;
    },
    async which(argv, frame) {
      let status = 0;
      for (const name of argv.slice(1)) {
        if (this.functions.has(name) || this.aliases.has(name) || Object.prototype.hasOwnProperty.call(BUILTINS, name)) { this.host.write(frame, `${name}: shell builtin`); continue; }
        const found = await this.host.which(name, this);
        if (found && found.kind === "script") this.host.write(frame, found.path);
        else if (found) this.host.write(frame, `/bin/${name}`);
        else status = 1;
      }
      return status;
    },

    async time(argv, frame) {
      const started = performance.now();
      const status = argv.length > 1 ? await this.invoke(argv.slice(1), frame) : 0;
      const seconds = ((performance.now() - started) / 1000).toFixed(3);
      this.host.error(frame, `real\t${seconds}s`);
      return status;
    }
  };
  BUILTINS["."] = BUILTINS.source;
  BUILTINS.run = BUILTINS.sh;
  BUILTINS.bash = BUILTINS.sh;
  BUILTINS.mwsh = BUILTINS.sh;

  const MWShell = {
    Shell, parse, tokenize, arithmetic, globToRegExp, quoteArg, makeInput, takeLine,
    ShellSyntaxError, ExitSignal, ReturnSignal, LoopSignal, Interrupt,
    builtinNames: () => Object.keys(BUILTINS)
  };
  if (typeof module !== "undefined" && module.exports) module.exports = MWShell;
  else global.MWShell = MWShell;
})(typeof window !== "undefined" ? window : globalThis);
