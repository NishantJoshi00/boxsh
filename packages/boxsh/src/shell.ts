// Shell parsing and execution.
import type { StorageBackend } from "./backend.js";
import { normalize } from "./backend.js";
import type { Engine } from "./engine.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

export interface ShellSession {
  env: Record<string, string>;
  cwd: string;
  lastStatus: number;
}

export interface ScriptResult {
  stdout: Uint8Array;
  stderr: Uint8Array;
  code: number;
}

interface Token {
  word?: string;
  op?: string;
}

interface Stage {
  argv: string[];
  in: string | null;
  out: string | null;
  append: boolean;
}

interface Chain {
  pipeline: Stage[];
  joiner: string | null;
}

const OPS = ["&&", "||", ";", "|", ">>", ">", "<"];
const HEREDOC_RE = /<<-?\s*(?:'([A-Za-z_]\w*)'|"([A-Za-z_]\w*)"|([A-Za-z_]\w*))/;

const concat = (chunks: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
};

export function createShell(
  engine: Engine,
  backendRef: { current: StorageBackend },
  session: ShellSession,
) {
  const expand = (s: string): string =>
    s.replace(/\$(\?|\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)/g, (_, k: string) => {
      const key = k === "?" ? "?" : k.replace(/[{}]/g, "");
      return key === "?" ? String(session.lastStatus) : (session.env[key] ?? "");
    });

  let subDepth = 0;
  function expandSubs(line: string): string {
    if (!line.includes("$(")) return line;
    if (subDepth > 8) throw new Error("command substitution nested too deep");
    let out = "";
    let i = 0;
    let sq = false;
    while (i < line.length) {
      const c = line[i];
      if (c === "'") {
        sq = !sq;
        out += c;
        i++;
      } else if (!sq && c === "$" && line[i + 1] === "(") {
        let depth = 1;
        let j = i + 2;
        for (; j < line.length && depth; j++) {
          if (line[j] === "(") depth++;
          else if (line[j] === ")") depth--;
        }
        if (depth) throw new Error("unterminated $( )");
        subDepth++;
        let text: string;
        try {
          text = dec.decode(execLine(line.slice(i + 2, j - 1), null, true).captured);
        } finally {
          subDepth--;
        }
        out += text.replace(/\s+/g, " ").trim();
        i = j;
      } else {
        out += c;
        i++;
      }
    }
    return out;
  }

  function tokenize(line: string): Token[] {
    const tokens: Token[] = [];
    let i = 0;
    let cur = "";
    let started = false;
    const flush = () => {
      if (started) tokens.push({ word: cur });
      cur = "";
      started = false;
    };
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
        let j = i + 1;
        let seg = "";
        for (; j < line.length && line[j] !== '"'; j++) {
          if (line[j] === "\\" && '"$\\'.includes(line[j + 1])) seg += line[++j];
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
        flush();
        i++;
      } else {
        const op = OPS.find((o) => line.startsWith(o, i));
        if (op) {
          flush();
          tokens.push({ op });
          i += op.length;
        } else if (c === "$") {
          const m = /^\$(\?|\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)/.exec(line.slice(i));
          if (m) {
            started = true;
            const key = m[1] === "?" ? "?" : m[1].replace(/[{}]/g, "");
            cur += key === "?" ? String(session.lastStatus) : (session.env[key] ?? "");
            i += m[0].length;
          } else {
            started = true;
            cur += c;
            i++;
          }
        } else {
          started = true;
          cur += c;
          i++;
        }
      }
    }
    flush();
    return tokens;
  }

  function parse(tokens: Token[]): Chain[] {
    const chains: Chain[] = [];
    let stages: Stage[] = [];
    let stage: Stage = { argv: [], in: null, out: null, append: false };
    let expect: "in" | "out" | null = null;
    const endStage = () => {
      stages.push(stage);
      stage = { argv: [], in: null, out: null, append: false };
    };
    const endChain = (joiner: string | null) => {
      endStage();
      chains.push({ pipeline: stages, joiner });
      stages = [];
    };
    for (const t of tokens) {
      if (t.word !== undefined) {
        if (expect === "in") {
          stage.in = t.word;
          expect = null;
        } else if (expect === "out") {
          stage.out = t.word;
          expect = null;
        } else stage.argv.push(t.word);
      } else if (t.op === "<") expect = "in";
      else if (t.op === ">") {
        stage.append = false;
        expect = "out";
      } else if (t.op === ">>") {
        stage.append = true;
        expect = "out";
      } else if (t.op === "|") endStage();
      else endChain(t.op ?? null);
    }
    endChain(null);
    return chains.filter((c) => c.pipeline.some((s) => s.argv.length));
  }

  type BuiltinResult = { out?: string; err?: string; code: number };
  const builtins: Record<string, (args: string[]) => BuiltinResult> = {
    ":": () => ({ code: 0 }),
    cd(argv) {
      const target = normalize(
        (argv[0] ?? session.env.HOME ?? "/").startsWith("/")
          ? (argv[0] ?? session.env.HOME ?? "/")
          : `${session.cwd}/${argv[0]}`,
      );
      const e = backendRef.current.entry(target);
      if (!e) return { err: `cd: ${argv[0] ?? ""}: No such file or directory\n`, code: 1 };
      if (e.kind !== "dir") return { err: `cd: ${argv[0]}: Not a directory\n`, code: 1 };
      session.cwd = "/" + target;
      return { code: 0 };
    },
    pwd: () => ({ out: session.cwd + "\n", code: 0 }),
    export(argv) {
      for (const a of argv) {
        const eq = a.indexOf("=");
        if (eq > 0) session.env[a.slice(0, eq)] = a.slice(eq + 1);
      }
      return { code: 0 };
    },
    unset(argv) {
      for (const a of argv) delete session.env[a];
      return { code: 0 };
    },
    env: () => ({
      out:
        Object.entries({ ...session.env, PWD: session.cwd })
          .map(([k, v]) => `${k}=${v}`)
          .join("\n") + "\n",
      code: 0,
    }),
  };

  const resolvePath = (p: string): string =>
    normalize(p.startsWith("/") ? p : `${session.cwd}/${p}`);

  interface LineResult {
    stdout: Uint8Array[];
    stderr: Uint8Array[];
    captured: Uint8Array;
  }

  function execLine(
    line: string,
    heredocBody: { raw: string; quoted: boolean } | null = null,
    capture = false,
  ): LineResult {
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    const captured: Uint8Array[] = [];
    const done = (): LineResult => ({ stdout, stderr, captured: concat(captured) });
    const fail = (msg: string): LineResult => {
      stderr.push(enc.encode(`boxsh: ${msg}\n`));
      session.lastStatus = 2;
      return done();
    };

    const fm = /^\s*for\s+([A-Za-z_]\w*)\s+in\s+(.+?)\s*;\s*do\s+(.+?)\s*;?\s*done\s*$/.exec(line);
    if (fm) {
      let words: string[];
      try {
        words = expand(expandSubs(fm[2])).split(/\s+/).filter(Boolean);
      } catch (e) {
        return fail((e as Error).message);
      }
      for (const w of words) {
        session.env[fm[1]] = w;
        const r = execLine(fm[3], null, capture);
        stdout.push(...r.stdout);
        stderr.push(...r.stderr);
        if (capture && r.captured.length) captured.push(r.captured);
      }
      return done();
    }

    let chains: Chain[];
    try {
      chains = parse(tokenize(expandSubs(line)));
    } catch (e) {
      return fail((e as Error).message);
    }

    let body = heredocBody;
    let skip: string | null = null;
    for (const { pipeline, joiner } of chains) {
      if (skip === "&&" && session.lastStatus !== 0) {
        skip = joiner;
        continue;
      }
      if (skip === "||" && session.lastStatus === 0) {
        skip = joiner;
        continue;
      }
      let data: Uint8Array = body
        ? enc.encode(body.quoted ? body.raw : expand(body.raw))
        : new Uint8Array(0);
      for (let s = 0; s < pipeline.length; s++) {
        const st = pipeline[s];
        const name = st.argv[0];
        if (st.in) {
          const e = backendRef.current.read(resolvePath(st.in));
          if (e === undefined) {
            stderr.push(enc.encode(`boxsh: ${st.in}: No such file or directory\n`));
            session.lastStatus = 1;
            break;
          }
          data = e;
        }
        let r: { out: Uint8Array; err: Uint8Array; code: number };
        if (builtins[name]) {
          const b = builtins[name](st.argv.slice(1));
          r = { out: enc.encode(b.out ?? ""), err: enc.encode(b.err ?? ""), code: b.code };
        } else if (engine.knows(name)) {
          r = engine.run(st.argv, data);
        } else {
          r = {
            out: new Uint8Array(0),
            err: enc.encode(`boxsh: ${name}: command not found\n`),
            code: 127,
          };
        }
        if (r.err.length) stderr.push(r.err);
        session.lastStatus = r.code;
        data = r.out;
        if (s === pipeline.length - 1) {
          if (st.out) {
            try {
              backendRef.current.write(resolvePath(st.out), data);
            } catch (e) {
              stderr.push(enc.encode(`boxsh: ${st.out}: ${(e as Error).message}\n`));
              session.lastStatus = 1;
            }
          } else if (capture) {
            if (data.length) captured.push(data);
          } else if (data.length) stdout.push(data);
        }
      }
      skip = joiner;
    }
    return done();
  }

  /** Execute a script: one or more lines, heredocs included. */
  function execScript(script: string): ScriptResult {
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    const lines = script.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      const m = HEREDOC_RE.exec(line);
      let body: { raw: string; quoted: boolean } | null = null;
      let cmd = line;
      if (m) {
        const tag = m[1] ?? m[2] ?? m[3];
        const quoted = Boolean(m[1] ?? m[2]);
        cmd = line.replace(m[0], "");
        const collected: string[] = [];
        i++;
        while (i < lines.length && lines[i] !== tag) collected.push(lines[i++]);
        body = { raw: collected.map((l) => l + "\n").join(""), quoted };
      }
      const r = execLine(cmd, body);
      stdout.push(...r.stdout);
      stderr.push(...r.stderr);
    }
    return { stdout: concat(stdout), stderr: concat(stderr), code: session.lastStatus };
  }

  return { execScript };
}
