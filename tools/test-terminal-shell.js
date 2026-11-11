// Tests for the Terminal shell (desktop/apps/terminal/shell.js).
// Run: node system/tools/test-terminal-shell.js
"use strict";
const assert = require("assert");
const path = require("path");
const MWShell = require(path.join(__dirname, "..", "desktop", "apps", "terminal", "shell.js"));

function makeHost(files = {}) {
  const screen = [];
  const errors = [];
  const fs = { ...files };
  const resolve = p => p.startsWith("/") ? p : `/home/${p.replace(/^\.\//, "")}`;
  const push = (frame, text, isError) => {
    if (isError) {
      if (frame && frame.err === "null") return;
      if (frame && Array.isArray(frame.err)) return frame.err.push(text);
      if (frame && frame.err === "out" && frame.out) return frame.out.push(text);
      return errors.push(text);
    }
    if (frame && frame.out) frame.out.push(text); else screen.push(text);
  };
  const host = {
    screen, errors, fs,
    write: (frame, text) => push(frame, text, false),
    error: (frame, text) => push(frame, text, true),
    cwd: () => "/home",
    interrupted: () => false,
    yield: () => Promise.resolve(),
    closeShell: () => { host.closed = true; },
    async readFile(p) { const key = resolve(p); if (!(key in fs)) throw new Error(`${p}: no such file`); return fs[key]; },
    async writeFile(p, text, append) { const key = resolve(p); fs[key] = append ? (fs[key] || "") + text : text; },
    async stat(p) { const key = resolve(p); if (key in fs) return { type: "file", bytes: fs[key].length }; if (Object.keys(fs).some(k => k.startsWith(key + "/"))) return { type: "folder" }; return null; },
    async glob(pattern) {
      const re = MWShell.globToRegExp(pattern);
      return Object.keys(fs).map(k => k.slice("/home/".length)).filter(name => re.test(name)).sort();
    },
    async readLine() { return host.nextInput || ""; },
    async which(name) { return name === "upper" ? { kind: "command" } : null; },
    // External commands for the tests: upper (stdin to upper case), args (print each arg),
    // fail (status 3), cat (stdin or files), wc-l.
    async exec(argv, frame, shell) {
      const [name, ...args] = argv;
      const stdin = () => { const t = frame.stdin ? frame.stdin.text : ""; if (frame.stdin) frame.stdin.text = ""; return t; };
      switch (name) {
        case "echo": host.write(frame, args.join(" ")); return 0;
        case "upper": stdin().split("\n").filter(Boolean).forEach(l => host.write(frame, l.toUpperCase())); return 0;
        case "args": args.forEach(a => host.write(frame, `<${a}>`)); return 0;
        case "fail": host.error(frame, "fail: failed"); return 3;
        case "cat": {
          const text = args.length ? (await Promise.all(args.map(a => host.readFile(a)))).join("") : stdin();
          text.replace(/\n$/, "").split("\n").forEach(l => host.write(frame, l));
          return 0;
        }
        case "wc-l": host.write(frame, String(stdin().split("\n").filter(Boolean).length)); return 0;
        default:
          if (name.endsWith(".mwex")) return shell.runScript(await host.readFile(name), args, name, frame);
          host.error(frame, `${name}: command not found`); return 127;
      }
    }
  };
  return host;
}

async function run(source, files, env = {}) {
  const host = makeHost(files);
  const shell = new MWShell.Shell(host, { env: { HOME: "/home", USER: "mario", ...env } });
  let status;
  try { status = await shell.run(source); }
  catch (error) { if (error instanceof MWShell.ExitSignal) status = error.status; else throw error; }
  return { out: host.screen, err: host.errors, status, fs: host.fs, shell, host };
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("echo and variables", async () => {
  const r = await run('x=world; echo "hello $x" ${x}s $USER');
  assert.deepStrictEqual(r.out, ["hello world worlds mario"]);
});
test("single quotes do not expand", async () => {
  const r = await run("x=1; echo '$x' \"$x\" \\$x");
  assert.deepStrictEqual(r.out, ["$x 1 $x"]);
});
test("word splitting and quoting", async () => {
  const r = await run('v="a  b"; args $v; args "$v"; args ""');
  assert.deepStrictEqual(r.out, ["<a>", "<b>", "<a  b>", "<>"]);
});
test("pipes", async () => {
  const r = await run("echo hello | upper | upper");
  assert.deepStrictEqual(r.out, ["HELLO"]);
});
test("&& || and $?", async () => {
  const r = await run("fail && echo no || echo yes; fail; echo $?");
  assert.deepStrictEqual(r.out, ["yes", "3"]);
  assert.deepStrictEqual(r.err, ["fail: failed", "fail: failed"]);
});
test("redirections", async () => {
  const r = await run("echo one > a.txt; echo two >> a.txt; cat a.txt; cat < a.txt | wc-l; fail 2>/dev/null; fail 2> e.txt; cat e.txt");
  assert.deepStrictEqual(r.out, ["one", "two", "2", "fail: failed"]);
  assert.strictEqual(r.fs["/home/a.txt"], "one\ntwo\n");
  assert.deepStrictEqual(r.err, []);
});
test("2>&1 into a pipe", async () => {
  const r = await run("fail 2>&1 | upper");
  assert.deepStrictEqual(r.out, ["FAIL: FAILED"]);
});
test("command substitution and arithmetic", async () => {
  const r = await run('n=$(echo 4); echo $((n * 2 + 1)) $(( (1+2) ** 2 )) $((7 / 2)) $((-3 + 1)) $((2 > 1 && 0 == 0))');
  assert.deepStrictEqual(r.out, ["9 9 3 -2 1"]);
});
test("if / elif / else with test", async () => {
  const r = await run(`
    for n in 1 5 10; do
      if [ $n -lt 3 ]; then echo small
      elif test $n -eq 5; then echo five
      else echo big; fi
    done`);
  assert.deepStrictEqual(r.out, ["small", "five", "big"]);
});
test("while with read from a file", async () => {
  const r = await run('while read line; do echo "[$line]"; done < list.txt', { "/home/list.txt": "a\nb c\n" });
  assert.deepStrictEqual(r.out, ["[a]", "[b c]"]);
});
test("while counter, break and continue", async () => {
  const r = await run("i=0; while true; do i=$((i+1)); if [ $i -eq 2 ]; then continue; fi; if [ $i -gt 4 ]; then break; fi; echo $i; done");
  assert.deepStrictEqual(r.out, ["1", "3", "4"]);
});
test("until", async () => {
  const r = await run("i=0; until [ $i -ge 3 ]; do echo $i; i=$((i+1)); done");
  assert.deepStrictEqual(r.out, ["0", "1", "2"]);
});
test("case", async () => {
  const r = await run(`for w in start stop x.mwex other; do
    case $w in
      start|begin) echo go;;
      stop) echo halt ;;
      *.mwex) echo script;;
      *) echo "?";;
    esac
  done`);
  assert.deepStrictEqual(r.out, ["go", "halt", "script", "?"]);
});
test("functions, local, return and positional parameters", async () => {
  const r = await run(`
    x=global
    greet() {
      local x=local
      echo "hi $1 ($#) $x"
      return 4
    }
    greet mario luigi; echo $? $x
    function twice { echo "$@"; echo "$@"; }
    twice a "b c"`);
  assert.deepStrictEqual(r.out, ["hi mario (2) local", "4 global", "a b c", "a b c"]);
});
test('"$@" keeps arguments', async () => {
  const r = await run('f() { args "$@"; }; f "a b" c; f');
  assert.deepStrictEqual(r.out, ["<a b>", "<c>"]);
});
test("parameter operations", async () => {
  const r = await run('f=hello.world.mwex; echo ${f%.mwex} ${f%%.*} ${f#*.} ${#f} ${missing:-dflt} ${f/world/there}; echo ${unset:=set}; echo $unset');
  assert.deepStrictEqual(r.out, ["hello.world hello world.mwex 16 dflt hello.there.mwex", "set", "set"]);
});
test("globbing", async () => {
  const r = await run('args *.txt; args "*.txt"; args *.none', { "/home/b.txt": "", "/home/a.txt": "", "/home/c.md": "" });
  assert.deepStrictEqual(r.out, ["<a.txt>", "<b.txt>", "<*.txt>", "<*.none>"]);
});
test("aliases", async () => {
  const r = await run("alias hi='echo hello there'; hi you");
  assert.deepStrictEqual(r.out, ["hello there you"]);
});
test(".mwex scripts get their own scope and arguments", async () => {
  const script = "#!/bin/mwsh\n# say hi\necho \"script $0 got $# args: $1\"\ninner=1\nexit 7\necho never\n";
  const r = await run("./hi.mwex one two; echo $? ${inner:-unset}", { "/home/hi.mwex": script });
  assert.deepStrictEqual(r.out, ["script ./hi.mwex got 2 args: one", "7 unset"]);
});
test("source runs in the same scope", async () => {
  const r = await run(". ./vars.mwex; echo $FROM", { "/home/vars.mwex": "FROM=sourced\n" });
  assert.deepStrictEqual(r.out, ["sourced"]);
});
test("set -e stops a script, but not on tested failures", async () => {
  const r = await run("sh s.mwex; echo after $?", { "/home/s.mwex": "set -e\nfail || echo handled\nif fail; then :; fi\necho before\nfail\necho never\n" });
  assert.deepStrictEqual(r.out, ["handled", "before", "after 3"]);
});
test("syntax errors in scripts name the line", async () => {
  const r = await run("sh bad.mwex", { "/home/bad.mwex": "echo ok\nif true; then\necho x\ndone\n" });
  assert.deepStrictEqual(r.out, []);
  assert.ok(/bad\.mwex: line 4: syntax error near unexpected token 'done'/.test(r.err[0]), r.err[0]);
});
test("incomplete input is reported as incomplete", async () => {
  for (const source of ["for i in 1 2; do", "echo 'open", "if true; then echo", "echo a &&", "echo $(echo"]) {
    assert.throws(() => MWShell.parse(source), e => e instanceof MWShell.ShellSyntaxError && e.incomplete, source);
  }
  assert.throws(() => MWShell.parse("fi"), e => !e.incomplete);
});
test("read from the user", async () => {
  const host = makeHost();
  host.nextInput = "  Mario Rossi ";
  const shell = new MWShell.Shell(host, {});
  await shell.run('read -p "name? " first last; echo "$last, $first"');
  assert.deepStrictEqual(host.screen, ["Rossi, Mario"]);
});
test("unknown command status 127 and ! negation", async () => {
  const r = await run("nope; echo $?; ! fail 2>/dev/null; echo $?");
  assert.deepStrictEqual(r.out, ["127", "0"]);
});
test("exit at an interactive prompt closes the shell", async () => {
  const host = makeHost();
  const shell = new MWShell.Shell(host, { interactive: true });
  await assert.rejects(shell.run("exit 2"), e => e instanceof MWShell.ExitSignal && e.status === 2);
  assert.strictEqual(host.closed, true);
});
test("VAR=value command is temporary", async () => {
  const r = await run("X=1; X=2 sh -c 'echo $X'; echo $X");
  assert.deepStrictEqual(r.out, ["2", "1"]);
});
test("comments and line continuation", async () => {
  const r = await run("echo a # comment\necho b \\\n c");
  assert.deepStrictEqual(r.out, ["a", "b c"]);
});
test("background jobs are refused", async () => {
  assert.throws(() => MWShell.parse("sleep 1 &"), /background/);
});

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try { await fn(); console.log(`ok   ${name}`); }
    catch (error) { failed++; console.log(`FAIL ${name}\n     ${error.message.split("\n").join("\n     ")}`); }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
