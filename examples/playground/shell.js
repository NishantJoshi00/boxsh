// nobox playground: 73 ported uutils coreutils (one wasm32-wasip1 multicall
// module) running against an in-page virtual store, behind a minimal shell
// line-parser (pipes, redirects, &&/||/;, quotes, $VARS, cd).
//
// Honest scope: this parser is a demo stand-in — the real bash interpreter is
// milestone M3, the real block-based VFS is M1, OPFS persistence is M2. The
// WASI syscall shim below is the architectural ancestor of nobox's real one.

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------- virtual store: path (no leading slash, "" = root) -> entry ----------
const store = new Map();
const now = () => Date.now();
const mkdir = (p) => store.set(p, { dir: true, mtime: now() });
const writeFile = (p, data, append = false) => {
  const prev = append ? store.get(p)?.data : null;
  const bytes = typeof data === "string" ? enc.encode(data) : data;
  const merged = prev ? concat([prev, bytes]) : bytes;
  store.set(p, { data: merged, mtime: now() });
};
const concat = (chunks) => {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
};
const norm = (p) => {
  const out = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
};
const childrenOf = (dir) =>
  [...store.keys()].filter(
    (k) => k !== "" && k.startsWith(dir === "" ? "" : dir + "/") &&
      !k.slice(dir === "" ? 0 : dir.length + 1).includes("/"),
  );

// ---------- boot filesystem ----------
mkdir("");
for (const d of ["root", "tmp", "etc", "usr", "usr/bin"]) mkdir(d);
writeFile("etc/motd", "Welcome to nobox — a filesystem pretending hard enough to be a computer.\n");
writeFile("etc/os-release",
  'NAME="nobox"\nVERSION="0.0.1 (fake sandbox)"\nID=nobox\nPRETTY_NAME="nobox 0.0.1 (wasm32)"\nHOME_URL="about:blank"\n');
writeFile("etc/hostname", "nobox\n");
writeFile("etc/passwd",
  "root:x:0:0:root:/root:/bin/bash\nagent:x:1000:1000:agent:/root:/bin/bash\n");
writeFile("root/README",
  "This machine is a browser tab.\nEverything you do here lives in a Map<string, Uint8Array>.\nRefresh the page and it is gone (persistence is milestone M2 — OPFS).\n");

let cwd = "root";
let lastStatus = 0;
const env = {
  HOME: "/root", USER: "agent", LOGNAME: "agent", HOSTNAME: "nobox",
  PATH: "/usr/local/bin:/usr/bin:/bin", TERM: "xterm-256color",
  SHELL: "/bin/bash", LANG: "C.UTF-8",
};

// ---------- WASI shim (ancestor of nobox's real syscall layer) ----------
const E = { OK: 0, BADF: 8, EXIST: 20, INVAL: 28, IO: 29, ISDIR: 31, NOENT: 44, NOSYS: 52, NOTDIR: 54, NOTEMPTY: 55 };
const FT = { DIR: 3, REG: 4, CHAR: 2 };
class ProcExit { constructor(code) { this.code = code; } }

let wasmModule = null;

function runWasm(argv, stdinBytes) {
  let memory;
  const view = () => new DataView(memory.buffer);
  const bytes = (p, l) => new Uint8Array(memory.buffer, p, l);
  // argv[0] doubles as the multicall selector and the visible program name
  // (uucore reads the process argv[0] for error prefixes like "cat: ...").
  const args = [argv[0], ...argv];
  const envPairs = Object.entries({ ...env, PWD: "/" + cwd }).map(([k, v]) => `${k}=${v}`);
  const stdin = stdinBytes ?? new Uint8Array(0);
  let stdinPos = 0;
  const stdout = [];
  const stderr = [];
  let nextFd = 5;
  // One preopen: "/". wasi-libc resolves cwd in userspace — the multicall
  // main seeds it from $PWD via set_current_dir — so every path arrives
  // here already cwd-resolved and slash-stripped (verified empirically:
  // absolute and relative are indistinguishable at this layer).
  const fds = new Map([[3, { path: "", dir: true, preopen: "/" }]]);
  const res = (_dirfd, raw) => norm(raw);
  const setStrings = (list, ptrsP, bufP) => {
    for (const s of list) {
      view().setUint32(ptrsP, bufP, true); ptrsP += 4;
      const b = enc.encode(s);
      bytes(bufP, b.length).set(b);
      view().setUint8(bufP + b.length, 0); bufP += b.length + 1;
    }
    return E.OK;
  };
  const fileStat = (buf, entry) => {
    bytes(buf, 64).fill(0);
    view().setUint8(buf + 16, entry.dir ? FT.DIR : FT.REG);
    view().setBigUint64(buf + 24, 1n, true);
    view().setBigUint64(buf + 32, BigInt(entry.data?.length ?? 0), true);
    const t = BigInt(entry.mtime ?? now()) * 1_000_000n;
    view().setBigUint64(buf + 40, t, true);
    view().setBigUint64(buf + 48, t, true);
    view().setBigUint64(buf + 56, t, true);
  };

  const impl = {
    args_sizes_get(cP, sP) {
      view().setUint32(cP, args.length, true);
      view().setUint32(sP, args.reduce((n, a) => n + enc.encode(a).length + 1, 0), true);
      return E.OK;
    },
    args_get: (aP, bP) => setStrings(args, aP, bP),
    environ_sizes_get(cP, sP) {
      view().setUint32(cP, envPairs.length, true);
      view().setUint32(sP, envPairs.reduce((n, a) => n + enc.encode(a).length + 1, 0), true);
      return E.OK;
    },
    environ_get: (aP, bP) => setStrings(envPairs, aP, bP),
    fd_prestat_get(fd, buf) {
      const pre = fds.get(fd)?.preopen;
      if (!pre) return E.BADF;
      view().setUint8(buf, 0);
      view().setUint32(buf + 4, pre.length, true);
      return E.OK;
    },
    fd_prestat_dir_name(fd, ptr) {
      const pre = fds.get(fd)?.preopen;
      if (!pre) return E.BADF;
      bytes(ptr, pre.length).set(enc.encode(pre));
      return E.OK;
    },
    path_create_directory(dirfd, pP, pL) {
      const p = res(dirfd, dec.decode(bytes(pP, pL)));
      if (store.has(p)) return E.EXIST;
      mkdir(p);
      return E.OK;
    },
    path_remove_directory(dirfd, pP, pL) {
      const p = res(dirfd, dec.decode(bytes(pP, pL)));
      const entry = store.get(p);
      if (!entry) return E.NOENT;
      if (!entry.dir) return E.NOTDIR;
      if (childrenOf(p).length) return E.NOTEMPTY;
      store.delete(p);
      return E.OK;
    },
    path_open(dirfd, dflags, pP, pL, oflags, rB, rI, fdflags, outP) {
      const p = res(dirfd, dec.decode(bytes(pP, pL)));
      const CREAT = 1, EXCL = 4, TRUNC = 8;
      const APPEND_FL = 1;
      let entry = store.get(p);
      if (entry && oflags & CREAT && oflags & EXCL) return E.EXIST;
      if (!entry) {
        if (!(oflags & CREAT)) return E.NOENT;
        entry = { data: new Uint8Array(0), mtime: now() };
        store.set(p, entry);
      } else if (!entry.dir && oflags & TRUNC) {
        entry.data = new Uint8Array(0);
        entry.mtime = now();
      }
      const fd = nextFd++;
      const pos = !entry.dir && fdflags & APPEND_FL ? entry.data.length : 0;
      fds.set(fd, entry.dir ? { path: p, dir: true } : { path: p, pos });
      view().setUint32(outP, fd, true);
      return E.OK;
    },
    path_filestat_get(dirfd, flags, pP, pL, buf) {
      const p = res(dirfd, dec.decode(bytes(pP, pL)));
      const entry = store.get(p);
      if (!entry) return E.NOENT;
      fileStat(buf, entry);
      return E.OK;
    },
    path_rename(od, oP, oL, nd, nP, nL) {
      const from = res(od, dec.decode(bytes(oP, oL)));
      const to = res(nd, dec.decode(bytes(nP, nL)));
      if (!store.has(from)) return E.NOENT;
      store.set(to, store.get(from));
      store.delete(from);
      for (const k of [...store.keys()]) {
        if (k.startsWith(from + "/")) {
          store.set(to + k.slice(from.length), store.get(k));
          store.delete(k);
        }
      }
      return E.OK;
    },
    path_unlink_file(dirfd, pP, pL) {
      const p = res(dirfd, dec.decode(bytes(pP, pL)));
      const entry = store.get(p);
      if (!entry) return E.NOENT;
      if (entry.dir) return E.ISDIR;
      store.delete(p);
      return E.OK;
    },
    fd_fdstat_get(fd, buf) {
      const ftype = fd <= 2 ? FT.CHAR : fds.get(fd)?.dir ? FT.DIR : FT.REG;
      bytes(buf, 24).fill(0);
      view().setUint8(buf, ftype);
      view().setBigUint64(buf + 8, 0xffffffffffffffffn, true);
      view().setBigUint64(buf + 16, 0xffffffffffffffffn, true);
      return E.OK;
    },
    fd_filestat_get(fd, buf) {
      if (fd <= 2) { bytes(buf, 64).fill(0); view().setUint8(buf + 16, FT.CHAR); return E.OK; }
      const f = fds.get(fd);
      if (!f) return E.BADF;
      fileStat(buf, store.get(f.path) ?? { dir: f.dir });
      return E.OK;
    },
    fd_readdir(fd, buf, bufLen, cookie, usedP) {
      const f = fds.get(fd);
      if (!f?.dir) return E.NOTDIR;
      const names = childrenOf(f.path).map((k) => k.split("/").pop()).sort();
      let used = 0;
      for (let i = Number(cookie); i < names.length; i++) {
        const name = enc.encode(names[i]);
        const need = 24 + name.length;
        if (used + need > bufLen) break;
        const at = buf + used;
        view().setBigUint64(at, BigInt(i + 1), true);
        view().setBigUint64(at + 8, BigInt(i + 100), true);
        view().setUint32(at + 16, name.length, true);
        const full = f.path === "" ? names[i] : `${f.path}/${names[i]}`;
        view().setUint8(at + 20, store.get(full)?.dir ? FT.DIR : FT.REG);
        bytes(at + 24, name.length).set(name);
        used += need;
      }
      view().setUint32(usedP, used, true);
      return E.OK;
    },
    fd_read(fd, iovsP, iovsLen, nP) {
      const f = fd === 0 ? null : fds.get(fd);
      if (fd !== 0 && !f) return E.BADF;
      const data = fd === 0 ? stdin : store.get(f.path)?.data ?? new Uint8Array(0);
      let pos = fd === 0 ? stdinPos : f.pos;
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const bp = view().getUint32(iovsP + i * 8, true);
        const bl = view().getUint32(iovsP + i * 8 + 4, true);
        const n = Math.min(bl, data.length - pos);
        bytes(bp, n).set(data.subarray(pos, pos + n));
        pos += n; total += n;
        if (n < bl) break;
      }
      if (fd === 0) stdinPos = pos; else f.pos = pos;
      view().setUint32(nP, total, true);
      return E.OK;
    },
    fd_write(fd, iovsP, iovsLen, nP) {
      let total = 0;
      const chunks = [];
      for (let i = 0; i < iovsLen; i++) {
        const bp = view().getUint32(iovsP + i * 8, true);
        const bl = view().getUint32(iovsP + i * 8 + 4, true);
        chunks.push(bytes(bp, bl).slice());
        total += bl;
      }
      if (fd === 1) stdout.push(...chunks);
      else if (fd === 2) stderr.push(...chunks);
      else {
        const f = fds.get(fd);
        if (!f) return E.BADF;
        const entry = store.get(f.path);
        if (!entry || entry.dir) return E.BADF;
        for (const c of chunks) {
          const grown = new Uint8Array(Math.max(entry.data.length, f.pos + c.length));
          grown.set(entry.data);
          grown.set(c, f.pos);
          entry.data = grown;
          f.pos += c.length;
        }
        entry.mtime = now();
      }
      view().setUint32(nP, total, true);
      return E.OK;
    },
    fd_seek(fd, off, whence, outP) {
      const f = fds.get(fd);
      if (!f || f.dir) return E.BADF;
      const len = store.get(f.path)?.data?.length ?? 0;
      const base = whence === 0 ? 0n : whence === 1 ? BigInt(f.pos) : BigInt(len);
      f.pos = Number(base + off);
      view().setBigUint64(outP, BigInt(f.pos), true);
      return E.OK;
    },
    fd_tell(fd, outP) {
      const f = fds.get(fd);
      if (!f || f.dir) return E.BADF;
      view().setBigUint64(outP, BigInt(f.pos), true);
      return E.OK;
    },
    fd_close(fd) { fds.delete(fd); return E.OK; },
    fd_sync: () => E.OK,
    fd_fdstat_set_flags: () => E.OK,
    fd_filestat_set_times: () => E.OK,
    path_filestat_set_times(dirfd, flags, pP, pL) {
      const p = res(dirfd, dec.decode(bytes(pP, pL)));
      const entry = store.get(p);
      if (!entry) return E.NOENT;
      entry.mtime = now();
      return E.OK;
    },
    clock_time_get(id, prec, outP) {
      view().setBigUint64(outP, BigInt(now()) * 1_000_000n, true);
      return E.OK;
    },
    random_get(p, l) { crypto.getRandomValues(bytes(p, l)); return E.OK; },
    sched_yield: () => E.OK,
    proc_exit(code) { throw new ProcExit(code); },
  };

  const imports = new Proxy(impl, {
    get: (t, name) =>
      t[name] ??
      ((...a) => {
        console.warn(`nobox: unimplemented syscall ${String(name)}`);
        return E.NOSYS;
      }),
  });

  const inst = new WebAssembly.Instance(wasmModule, { wasi_snapshot_preview1: imports });
  memory = inst.exports.memory;
  let code = 0;
  try {
    inst.exports._start();
  } catch (e) {
    if (e instanceof ProcExit) code = e.code;
    else { stderr.push(enc.encode(`nobox: ${argv[0]}: crashed: ${e}\n`)); code = 139; }
  }
  return { out: concat(stdout), err: concat(stderr), code };
}

// ---------- shell: tokenize / expand / parse / execute ----------
const OPS = ["&&", "||", ";", "|", ">>", ">", "<"];

function tokenize(line) {
  const tokens = [];
  let i = 0, cur = "", started = false;
  const flush = () => { if (started) tokens.push({ word: cur }); cur = ""; started = false; };
  while (i < line.length) {
    const c = line[i];
    if (c === "'") {
      started = true;
      const end = line.indexOf("'", i + 1);
      if (end === -1) throw new Error("unterminated '");
      cur += line.slice(i + 1, end);
      i = end + 1;
    } else if (c === '"') {
      started = true;
      let j = i + 1, seg = "";
      for (; j < line.length && line[j] !== '"'; j++) {
        if (line[j] === "\\" && '"$\\'.includes(line[j + 1])) { seg += line[++j]; }
        else seg += line[j];
      }
      if (j >= line.length) throw new Error('unterminated "');
      cur += expand(seg);
      i = j + 1;
    } else if (c === "\\") {
      started = true;
      cur += line[i + 1] ?? "";
      i += 2;
    } else if (c === " " || c === "\t") {
      flush(); i++;
    } else {
      const op = OPS.find((o) => line.startsWith(o, i));
      if (op) { flush(); tokens.push({ op }); i += op.length; }
      else { started = true; cur += expand1(line, i, (s, ni) => { i = ni; return s; }) ?? line[i++]; }
    }
  }
  flush();
  return tokens;
}

// expand $VAR / ${VAR} / $? starting at line[i] if it's a '$'; helper for tokenize
function expand1(line, i, commit) {
  if (line[i] !== "$") return null;
  const m = /^\$(\?|\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)/.exec(line.slice(i));
  if (!m) return null;
  const key = m[1] === "?" ? "?" : m[1].replace(/[{}]/g, "");
  const val = key === "?" ? String(lastStatus) : env[key] ?? "";
  return commit(val, i + m[0].length);
}
const expand = (s) =>
  s.replace(/\$(\?|\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)/g, (_, k) => {
    const key = k === "?" ? "?" : k.replace(/[{}]/g, "");
    return key === "?" ? String(lastStatus) : env[key] ?? "";
  });

function parse(tokens) {
  // -> [{ pipeline: [ {argv, in, out, append} ], joiner: '&&'|'||'|';'|null }]
  const chains = [];
  let stages = [], stage = { argv: [], in: null, out: null, append: false };
  let expect = null;
  const endStage = () => { stages.push(stage); stage = { argv: [], in: null, out: null, append: false }; };
  const endChain = (joiner) => { endStage(); chains.push({ pipeline: stages, joiner }); stages = []; };
  for (const t of tokens) {
    if (t.word !== undefined) {
      if (expect === "in") { stage.in = t.word; expect = null; }
      else if (expect === "out") { stage.out = t.word; expect = null; }
      else stage.argv.push(t.word);
    } else if (t.op === "<") expect = "in";
    else if (t.op === ">") { stage.append = false; expect = "out"; }
    else if (t.op === ">>") { stage.append = true; expect = "out"; }
    else if (t.op === "|") endStage();
    else endChain(t.op);
  }
  endChain(null);
  return chains.filter((c) => c.pipeline.some((s) => s.argv.length));
}

const KNOWN = new Set(("arch b2sum base32 base64 basename basenc cat cksum comm cp csplit cut date dd dir dircolors " +
  "dirname echo expand factor false fmt fold head join link ln ls md5sum mkdir mktemp mv nl nproc numfmt od paste " +
  "pathchk pr printenv printf ptx pwd readlink realpath rm rmdir seq sha1sum sha224sum sha256sum sha384sum sha512sum " +
  "shred shuf sleep sort split sum tail tee touch tr true truncate tsort uname unexpand uniq unlink vdir wc yes").split(" "));

const BUILTINS = {
  cd(args) {
    const target = norm(
      (args[0] ?? env.HOME).startsWith("/") ? args[0] ?? env.HOME : `${cwd}/${args[0]}`,
    );
    const entry = store.get(target);
    if (!entry) return { err: `cd: ${args[0] ?? env.HOME}: No such file or directory\n`, code: 1 };
    if (!entry.dir) return { err: `cd: ${args[0]}: Not a directory\n`, code: 1 };
    cwd = target;
    return { code: 0 };
  },
  pwd: () => ({ out: "/" + cwd + "\n", code: 0 }),
  export(args) {
    for (const a of args) {
      const eq = a.indexOf("=");
      if (eq > 0) env[a.slice(0, eq)] = a.slice(eq + 1);
    }
    return { code: 0 };
  },
  unset(args) { for (const a of args) delete env[a]; return { code: 0 }; },
  env: () => ({ out: Object.entries({ ...env, PWD: "/" + cwd }).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", code: 0 }),
  hostname: () => ({ out: env.HOSTNAME + "\n", code: 0 }),
  whoami: () => ({ out: env.USER + "\n", code: 0 }),
  uname(args) {
    const a = args.includes("-a");
    const parts = a
      ? ["Linux", env.HOSTNAME, "6.9.0-nobox", "#1 SMP nobox v0.0.1", "wasm32", "GNU/Linux"]
      : args.includes("-m") ? ["wasm32"] : args.includes("-n") ? [env.HOSTNAME] : ["Linux"];
    return { out: parts.join(" ") + "\n", code: 0 };
  },
  which(args) {
    const hits = args.map((a) =>
      KNOWN.has(a) || BUILTINS[a] ? `/usr/bin/${a}` : null,
    );
    return hits.every(Boolean)
      ? { out: hits.join("\n") + "\n", code: 0 }
      : { err: hits.map((h, i) => h ?? `which: no ${args[i]} in (${env.PATH})`).filter((x) => x.startsWith("which")).join("\n") + "\n", code: 1 };
  },
  exit: () => ({ out: "logout\n(this is a browser tab — there is no escape)\n", code: 0 }),
  help: () => ({
    out:
      "nobox playground — ported GNU coreutils (via uutils) on a virtual filesystem, in your tab.\n" +
      "shell features: pipes |   redirects > >> <   chaining && || ;   quotes   $VARS   cd/export\n" +
      "commands: " + [...KNOWN].sort().join(" ") + "\n" +
      "builtins: " + Object.keys(BUILTINS).sort().join(" ") + "\n" +
      "not yet: bash scripting (M3), grep/sed/find (M4, native), persistence across refresh (M2, OPFS)\n",
    code: 0,
  }),
  clear: () => (screen.textContent = "", { code: 0 }),
};

function execLine(line) {
  let chains;
  try {
    chains = parse(tokenize(line));
  } catch (e) {
    printErr(`nobox: parse error: ${e.message}\n`);
    lastStatus = 2;
    return;
  }
  let skip = null;
  for (const { pipeline, joiner } of chains) {
    if (skip === "&&" && lastStatus !== 0) { skip = joiner; continue; }
    if (skip === "||" && lastStatus === 0) { skip = joiner; continue; }
    let data = new Uint8Array(0);
    for (let s = 0; s < pipeline.length; s++) {
      const st = pipeline[s];
      const name = st.argv[0];
      if (st.in) {
        const p = norm(st.in.startsWith("/") ? st.in : `${cwd}/${st.in}`);
        const entry = store.get(p);
        if (!entry || entry.dir) { printErr(`nobox: ${st.in}: No such file or directory\n`); lastStatus = 1; break; }
        data = entry.data;
      }
      let r;
      if (BUILTINS[name]) {
        const b = BUILTINS[name](st.argv.slice(1));
        r = { out: enc.encode(b.out ?? ""), err: enc.encode(b.err ?? ""), code: b.code };
      } else if (KNOWN.has(name)) {
        r = runWasm(st.argv, data);
      } else {
        r = { out: new Uint8Array(0), err: enc.encode(`nobox: ${name}: command not found\n`), code: 127 };
      }
      if (r.err.length) printErr(dec.decode(r.err));
      lastStatus = r.code;
      data = r.out;
      if (s === pipeline.length - 1) {
        if (st.out) {
          const p = norm(st.out.startsWith("/") ? st.out : `${cwd}/${st.out}`);
          writeFile(p, data, st.append);
        } else if (data.length) print(dec.decode(data));
      }
    }
    skip = joiner;
  }
}

// ---------- terminal ----------
const screen = document.getElementById("screen");
const input = document.getElementById("input");
const promptEl = document.getElementById("prompt");
const history = [];
let histAt = 0;

const prettyCwd = () => {
  const abs = "/" + cwd;
  return abs === "/root" ? "~" : abs.startsWith("/root/") ? "~" + abs.slice(5) : abs;
};
const promptHtml = () =>
  `<span class="ps-user">${env.USER}@${env.HOSTNAME}</span>:<span class="ps-path">${prettyCwd()}</span>$ `;

function print(text, cls) {
  const span = document.createElement("span");
  if (cls) span.className = cls;
  span.textContent = text;
  screen.appendChild(span);
  screen.scrollTop = screen.scrollHeight;
}
const printErr = (t) => print(t, "err");
const printHtml = (html) => {
  const span = document.createElement("span");
  span.innerHTML = html;
  screen.appendChild(span);
};

function refreshPrompt() { promptEl.innerHTML = promptHtml(); }

input.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") {
    const line = input.value;
    input.value = "";
    printHtml(promptHtml());
    print(line + "\n");
    if (line.trim()) {
      history.push(line);
      histAt = history.length;
      try { execLine(line); } catch (e) { printErr(`nobox: internal error: ${e}\n`); }
    }
    refreshPrompt();
  } else if (ev.key === "ArrowUp") {
    if (histAt > 0) input.value = history[--histAt];
    ev.preventDefault();
  } else if (ev.key === "ArrowDown") {
    input.value = histAt < history.length - 1 ? history[++histAt] : ((histAt = history.length), "");
    ev.preventDefault();
  } else if (ev.key === "c" && ev.ctrlKey) {
    printHtml(promptHtml());
    print(input.value + "^C\n");
    input.value = "";
  } else if (ev.key === "l" && ev.ctrlKey) {
    screen.textContent = "";
    ev.preventDefault();
  }
});
document.body.addEventListener("click", () => input.focus());

// ---------- boot ----------
(async () => {
  print("booting nobox", "dim");
  try {
    const url = "./coreutils-demo/target/wasm32-wasip1/release/coreutils-demo.wasm";
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`${resp.status} fetching ${url} — build it first (see README.md)`);
    try {
      wasmModule = await WebAssembly.compileStreaming(resp.clone());
    } catch {
      wasmModule = await WebAssembly.compile(await resp.arrayBuffer());
    }
    print(" ... ok\n\n", "dim");
    print(dec.decode(store.get("etc/motd").data));
    print(`Last login: ${new Date().toUTCString()} from the same tab\n`, "dim");
    print("type `help` if the illusion breaks\n\n", "dim");
  } catch (e) {
    printErr(`\nboot failed: ${e.message}\n`);
  }
  refreshPrompt();
  input.focus();
})();
