//! Shell language semantics, pinned against the TypeScript shell this crate
//! ports (shell.ts + the shell sections of packages/boxsh/test/api.mjs).
//! Commands run through a scripted double — the shell under test is real,
//! the coreutils are not (they have their own crates and tests).

use boxsh_fs::{Backend, MemoryBackend};
use boxsh_shell::{CommandOutput, CommandRunner, Env, ScriptResult, Session, exec_script};

/// Minimal stdin/argv-pure stand-ins for the commands api.mjs exercises.
struct Utils;

impl CommandRunner for Utils {
    fn knows(&self, name: &str) -> bool {
        matches!(
            name,
            "echo" | "cat" | "seq" | "tail" | "sort" | "wc" | "grep" | "tr" | "true" | "false"
        )
    }

    fn run(&mut self, argv: &[String], stdin: &[u8], _session: &Session) -> CommandOutput {
        let ok = |out: String| CommandOutput {
            out: out.into_bytes(),
            err: Vec::new(),
            code: 0,
        };
        let text = || String::from_utf8_lossy(stdin).to_string();
        let lines = |s: &str| s.lines().map(str::to_string).collect::<Vec<_>>();
        match argv[0].as_str() {
            "true" => ok(String::new()),
            "false" => CommandOutput {
                out: Vec::new(),
                err: Vec::new(),
                code: 1,
            },
            "echo" => ok(format!("{}\n", argv[1..].join(" "))),
            "cat" => CommandOutput {
                out: stdin.to_vec(),
                err: Vec::new(),
                code: 0,
            },
            "seq" => {
                let a: i64 = argv[1].parse().unwrap();
                let b: i64 = argv[2].parse().unwrap();
                ok((a..=b).map(|n| format!("{n}\n")).collect())
            }
            "tail" => {
                let n: usize = argv[1].trim_start_matches('-').parse().unwrap();
                let all = text();
                let l = lines(&all);
                ok(l[l.len().saturating_sub(n)..]
                    .iter()
                    .map(|s| format!("{s}\n"))
                    .collect())
            }
            "sort" => {
                let all = text();
                let mut l = lines(&all);
                l.sort();
                if argv.get(1).map(String::as_str) == Some("-r") {
                    l.reverse();
                }
                ok(l.iter().map(|s| format!("{s}\n")).collect())
            }
            "wc" => ok(format!(
                "{}\n",
                stdin.iter().filter(|&&b| b == b'\n').count()
            )),
            "grep" => {
                let (count, pat) = if argv[1] == "-c" {
                    (true, argv[2].as_str())
                } else {
                    (false, argv[1].as_str())
                };
                let all = text();
                let hits: Vec<&str> = all.lines().filter(|l| l.contains(pat)).collect();
                let out = if count {
                    format!("{}\n", hits.len())
                } else {
                    hits.iter().map(|l| format!("{l}\n")).collect()
                };
                let code = if hits.is_empty() { 1 } else { 0 };
                CommandOutput {
                    out: out.into_bytes(),
                    err: Vec::new(),
                    code,
                }
            }
            "tr" => ok(text().to_uppercase()),
            other => panic!("double has no {other}"),
        }
    }
}

struct Harness {
    backend: MemoryBackend,
    session: Session,
}

impl Harness {
    fn new() -> Self {
        let mut session = Session::new();
        session.env = Env::from_iter([("HOME", "/"), ("USER", "agent")]);
        Harness {
            backend: MemoryBackend::new(),
            session,
        }
    }

    fn exec(&mut self, script: &str) -> ScriptResult {
        exec_script(&mut self.backend, &mut Utils, &mut self.session, script)
    }

    fn out(&mut self, script: &str) -> String {
        let r = self.exec(script);
        String::from_utf8(r.stdout).unwrap()
    }

    fn err(&mut self, script: &str) -> (String, i32) {
        let r = self.exec(script);
        (String::from_utf8(r.stderr).unwrap(), r.code)
    }
}

#[test]
fn echo_env_and_state_persist_across_execs() {
    let mut h = Harness::new();
    assert_eq!(h.out("echo hello from $USER"), "hello from agent\n");
    h.backend.mkdir("src").unwrap();
    h.exec("export GREETING=hey && cd /src");
    assert_eq!(h.session.cwd, "/src");
    assert_eq!(h.out("echo $GREETING $(pwd)"), "hey /src\n");
}

#[test]
fn pipelines_redirects_and_relative_paths() {
    let mut h = Harness::new();
    h.backend.mkdir("src").unwrap();
    h.exec("cd /src");
    h.exec("seq 1 100 | tail -3 | sort -r > top.txt");
    assert_eq!(h.backend.read("src/top.txt").unwrap(), b"99\n98\n100\n");
}

#[test]
fn heredoc_multiline_script() {
    let mut h = Harness::new();
    let r = h.out("cat <<EOF > note.txt\nline one\nline two\nEOF\nwc -l < note.txt");
    assert_eq!(r.trim(), "2");
    assert_eq!(h.backend.read("note.txt").unwrap(), b"line one\nline two\n");
}

#[test]
fn heredoc_quoting_controls_expansion() {
    let mut h = Harness::new();
    h.exec("export NAME=world");
    assert_eq!(h.out("cat <<EOF\nhi $NAME\nEOF"), "hi world\n");
    assert_eq!(h.out("cat <<'EOF'\nhi $NAME\nEOF"), "hi $NAME\n");
    assert_eq!(h.out("cat <<\"EOF\"\nhi $NAME\nEOF"), "hi $NAME\n");
}

#[test]
fn command_not_found_is_a_code_not_a_crash() {
    let mut h = Harness::new();
    let (err, code) = h.err("definitely-not-a-command");
    assert_eq!(code, 127);
    assert!(err.contains("command not found"), "{err}");
}

#[test]
fn quoting_rules() {
    let mut h = Harness::new();
    h.exec("export V=val");
    assert_eq!(h.out("echo '$V literal'"), "$V literal\n");
    assert_eq!(h.out("echo \"$V quoted\""), "val quoted\n");
    assert_eq!(h.out("echo \"a\\\"b \\$V \\\\\""), "a\"b $V \\\n");
    assert_eq!(h.out("echo a\\ b"), "a b\n");
    assert_eq!(h.out("echo ''"), "\n"); // empty word survives
    let (err, code) = h.err("echo 'unterminated");
    assert_eq!(code, 2);
    assert!(err.contains("unterminated '"));
    let (err, code) = h.err("echo \"unterminated");
    assert_eq!(code, 2);
    assert!(err.contains("unterminated \""));
}

#[test]
fn variable_forms() {
    let mut h = Harness::new();
    h.exec("export AB=x ABC=y");
    assert_eq!(h.out("echo $AB-$ABC ${AB}C"), "x-y xC\n");
    assert_eq!(h.out("echo $MISSING."), ".\n");
    assert_eq!(h.out("echo $ $5"), "$ $5\n"); // no ident: literal
    h.exec("false");
    assert_eq!(h.out("echo $?"), "1\n");
    h.exec("true");
    assert_eq!(h.out("echo $?"), "0\n");
}

#[test]
fn command_substitution() {
    let mut h = Harness::new();
    assert_eq!(h.out("echo [$(echo inner)]"), "[inner]\n");
    // Captured output collapses internal whitespace.
    assert_eq!(h.out("echo $(seq 1 3)"), "1 2 3\n");
    // Nesting.
    assert_eq!(h.out("echo $(echo $(echo deep))"), "deep\n");
    // Single quotes suppress it.
    assert_eq!(h.out("echo '$(echo nope)'"), "$(echo nope)\n");
    let (err, code) = h.err("echo $(echo unterminated");
    assert_eq!(code, 2);
    assert!(err.contains("unterminated $( )"));
}

#[test]
fn substitution_depth_is_capped() {
    let mut h = Harness::new();
    let mut script = "echo hi".to_string();
    for _ in 0..12 {
        script = format!("echo $({script})");
    }
    // The innermost level fails and the message bubbles up through the
    // capture chain; the outer echoes still run (with empty output).
    let (err, _) = h.err(&script);
    assert!(err.contains("nested too deep"), "{err}");
}

#[test]
fn substitution_stderr_reaches_the_caller() {
    let mut h = Harness::new();
    let r = h.exec("echo [$(no-such-cmd)]");
    assert_eq!(r.stdout, b"[]\n");
    assert!(
        String::from_utf8(r.stderr)
            .unwrap()
            .contains("no-such-cmd: command not found")
    );
}

#[test]
fn conditional_chains() {
    let mut h = Harness::new();
    assert_eq!(h.out("true && echo yes"), "yes\n");
    assert_eq!(h.out("false && echo yes"), "");
    assert_eq!(h.out("false || echo fallback"), "fallback\n");
    assert_eq!(h.out("true || echo fallback"), "");
    assert_eq!(h.out("false ; echo always"), "always\n");
    // Skip chains through the joiner that follows the skipped chain.
    assert_eq!(h.out("false && echo a || echo b"), "b\n");
    assert_eq!(h.out("true && echo a || echo b"), "a\n");
}

#[test]
fn redirects() {
    let mut h = Harness::new();
    h.exec("echo one > f.txt");
    assert_eq!(h.backend.read("f.txt").unwrap(), b"one\n");
    h.exec("echo two > f.txt");
    assert_eq!(h.backend.read("f.txt").unwrap(), b"two\n");
    h.exec("echo three >> f.txt");
    assert_eq!(h.backend.read("f.txt").unwrap(), b"two\nthree\n");
    h.exec("echo fresh >> new.txt"); // append to a missing file creates it
    assert_eq!(h.backend.read("new.txt").unwrap(), b"fresh\n");
    assert_eq!(h.out("cat < f.txt"), "two\nthree\n");
    let (err, code) = h.err("cat < missing.txt");
    assert_eq!(code, 1);
    assert!(err.contains("missing.txt: No such file or directory"));
    // Write failure surfaces on stderr with status 1.
    h.backend.mkdir("d").unwrap();
    let (err, code) = h.err("echo x > d");
    assert_eq!(code, 1);
    assert!(err.contains("boxsh: d:"), "{err}");
}

#[test]
fn for_loops() {
    let mut h = Harness::new();
    assert_eq!(h.out("for i in 1 2 3; do echo n$i; done"), "n1\nn2\nn3\n");
    // Words expand, including substitutions; body sees pipes.
    assert_eq!(
        h.out("for w in $(seq 1 2) three; do echo $w | cat; done"),
        "1\n2\nthree\n"
    );
    // Optional trailing semicolon before done.
    assert_eq!(
        h.out("for i in a; do echo $i done marker; done"),
        "a done marker\n"
    );
    // Loop variable persists after the loop, like the original.
    h.exec("for i in last; do true; done");
    assert_eq!(h.out("echo $i"), "last\n");
}

#[test]
fn builtins() {
    let mut h = Harness::new();
    h.backend.mkdir("dir").unwrap();
    h.backend.write("file", b"x").unwrap();

    assert_eq!(h.out("pwd"), "/\n");
    h.exec("cd dir");
    assert_eq!(h.session.cwd, "/dir");
    assert_eq!(h.out("pwd"), "/dir\n");
    h.exec("cd");
    assert_eq!(h.session.cwd, "/"); // HOME
    let (err, code) = h.err("cd missing");
    assert_eq!(code, 1);
    assert!(err.contains("cd: missing: No such file or directory"));
    let (err, code) = h.err("cd file");
    assert_eq!(code, 1);
    assert!(err.contains("cd: file: Not a directory"));

    h.exec("export A=1 B=2 not-an-assignment");
    assert_eq!(h.session.env.get("A"), Some("1"));
    assert_eq!(h.session.env.get("B"), Some("2"));
    h.exec("unset A");
    assert_eq!(h.session.env.get("A"), None);

    // env prints insertion order with PWD appended last.
    let env_out = h.out("env");
    let last = env_out.lines().last().unwrap();
    assert_eq!(last, "PWD=/");
    assert!(env_out.starts_with("HOME=/\nUSER=agent\n"), "{env_out}");

    let r = h.exec(":");
    assert_eq!(r.code, 0);
}

#[test]
fn blank_lines_and_multi_line_scripts() {
    let mut h = Harness::new();
    assert_eq!(h.out("echo a\n\n   \necho b"), "a\nb\n");
    let r = h.exec("false\n");
    assert_eq!(r.code, 1); // script code is the last status
}

#[test]
fn two_sessions_share_one_backend() {
    let mut backend = MemoryBackend::new();
    let mut s1 = Session::new();
    let mut s2 = Session::new();
    exec_script(&mut backend, &mut Utils, &mut s1, "echo shared > f.txt");
    let r = exec_script(&mut backend, &mut Utils, &mut s2, "cat < f.txt");
    assert_eq!(r.stdout, b"shared\n");
}

#[test]
fn empty_pipeline_stage_is_command_not_found() {
    let mut h = Harness::new();
    let (err, code) = h.err("echo a | ");
    assert_eq!(code, 127);
    assert!(err.contains("command not found"));
}
