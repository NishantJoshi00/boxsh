//! The boxsh shell language, ported from the TypeScript implementation
//! (shell.ts) it supersedes: tokenizing with quoting and `$` expansion,
//! pipelines, redirects, `&&`/`||`/`;` chains, heredocs, `for` loops,
//! `$( )` command substitution, and the session builtins. Commands execute
//! through a [`CommandRunner`]; storage through [`boxsh_fs::Backend`].
//!
//! No regex dependency — the three scanners (variable references, heredoc
//! introducers, `for` headers) are hand-rolled to match the original
//! patterns exactly.
//!
//! Deliberate divergences from shell.ts, all bug fixes: `>>` genuinely
//! appends (the original parsed the flag but truncated anyway); `\$` inside
//! double quotes stays literal (the original escaped it, then re-expanded
//! the segment); stderr produced inside `$( )` substitutions reaches the
//! caller (the original silently dropped it, including its own
//! nested-too-deep error); and an empty pipeline stage reports
//! `command not found` instead of a stringified-undefined name.

use boxsh_fs::{Backend, Kind, normalize};

/// Output of one command execution.
pub struct CommandOutput {
    pub out: Vec<u8>,
    pub err: Vec<u8>,
    pub code: i32,
}

/// Executes commands for the shell. The engine (wasm coreutils) implements
/// this; tests use scripted doubles. `session` is the live state at the
/// moment of invocation, so mid-script `cd` and `export` reach every
/// command — not just the ones after the next exec boundary.
pub trait CommandRunner {
    fn knows(&self, name: &str) -> bool;
    fn run(&mut self, argv: &[String], stdin: &[u8], session: &Session) -> CommandOutput;
}

/// Insertion-ordered environment, matching JS object key order so the
/// `env` builtin prints identically to the TypeScript shell.
#[derive(Debug, Clone, Default)]
pub struct Env {
    entries: Vec<(String, String)>,
}

impl Env {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get(&self, key: &str) -> Option<&str> {
        self.entries
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }

    pub fn set(&mut self, key: &str, value: &str) {
        match self.entries.iter_mut().find(|(k, _)| k == key) {
            Some((_, v)) => *v = value.to_string(),
            None => self.entries.push((key.to_string(), value.to_string())),
        }
    }

    pub fn remove(&mut self, key: &str) {
        self.entries.retain(|(k, _)| k != key);
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, &str)> {
        self.entries.iter().map(|(k, v)| (k.as_str(), v.as_str()))
    }
}

impl<K: Into<String>, V: Into<String>> FromIterator<(K, V)> for Env {
    fn from_iter<T: IntoIterator<Item = (K, V)>>(iter: T) -> Self {
        let mut env = Env::new();
        for (k, v) in iter {
            env.set(&k.into(), &v.into());
        }
        env
    }
}

/// Shell session state, persistent across `exec_script` calls.
pub struct Session {
    pub env: Env,
    /// Absolute, `/`-prefixed.
    pub cwd: String,
    pub last_status: i32,
}

impl Session {
    pub fn new() -> Self {
        Session {
            env: Env::new(),
            cwd: "/".to_string(),
            last_status: 0,
        }
    }
}

impl Default for Session {
    fn default() -> Self {
        Self::new()
    }
}

pub struct ScriptResult {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub code: i32,
}

/// Execute a script: one or more lines, heredocs included.
pub fn exec_script(
    backend: &mut (impl Backend + ?Sized),
    runner: &mut (impl CommandRunner + ?Sized),
    session: &mut Session,
    script: &str,
) -> ScriptResult {
    let mut ctx = Ctx {
        backend,
        runner,
        session,
        sub_depth: 0,
    };
    ctx.exec_script(script)
}

// ---------------------------------------------------------------------------
// scanners (regex stand-ins)

/// `$?`, `${NAME}`, or `$NAME` at `chars[i]` (which must be `'$'`).
/// Returns (key, chars consumed); key `"?"` means the last status.
fn var_ref(chars: &[char], i: usize) -> Option<(String, usize)> {
    let is_start = |c: char| c.is_ascii_alphabetic() || c == '_';
    let is_cont = |c: char| c.is_ascii_alphanumeric() || c == '_';
    match chars.get(i + 1) {
        Some('?') => Some(("?".to_string(), 2)),
        Some('{') => {
            let mut j = i + 2;
            if !chars.get(j).copied().is_some_and(is_start) {
                return None;
            }
            while chars.get(j).copied().is_some_and(is_cont) {
                j += 1;
            }
            if chars.get(j) == Some(&'}') {
                Some((chars[i + 2..j].iter().collect(), j + 1 - i))
            } else {
                None
            }
        }
        Some(&c) if is_start(c) => {
            let mut j = i + 1;
            while chars.get(j).copied().is_some_and(is_cont) {
                j += 1;
            }
            Some((chars[i + 1..j].iter().collect(), j - i))
        }
        _ => None,
    }
}

/// First heredoc introducer in the line: `<<-? \s* ('TAG'|"TAG"|TAG)`.
/// Returns (byte start, byte end, tag, quoted).
fn scan_heredoc(line: &str) -> Option<(usize, usize, String, bool)> {
    let b = line.as_bytes();
    let ident_end = |from: usize| -> Option<usize> {
        let first = *b.get(from)?;
        if !(first.is_ascii_alphabetic() || first == b'_') {
            return None;
        }
        let mut j = from + 1;
        while j < b.len() && (b[j].is_ascii_alphanumeric() || b[j] == b'_') {
            j += 1;
        }
        Some(j)
    };
    let mut i = 0;
    while i + 1 < b.len() {
        if b[i] == b'<' && b[i + 1] == b'<' {
            let mut j = i + 2;
            if b.get(j) == Some(&b'-') {
                j += 1;
            }
            while j < b.len() && b[j].is_ascii_whitespace() {
                j += 1;
            }
            let quote = b.get(j).copied().filter(|&q| q == b'\'' || q == b'"');
            let tag_start = if quote.is_some() { j + 1 } else { j };
            if let Some(tag_end) = ident_end(tag_start) {
                let end = match quote {
                    Some(q) if b.get(tag_end) == Some(&q) => Some(tag_end + 1),
                    Some(_) => None,
                    None => Some(tag_end),
                };
                if let Some(end) = end {
                    return Some((
                        i,
                        end,
                        line[tag_start..tag_end].to_string(),
                        quote.is_some(),
                    ));
                }
            }
        }
        i += 1;
    }
    None
}

/// `^\s*for IDENT in WORDS ; do BODY ;? done\s*$` with the original's lazy
/// matching: the first `; do ` boundary wins, and the body is the smallest
/// prefix whose tail is `\s* ;? \s* done \s*`.
fn parse_for(line: &str) -> Option<(String, String, String)> {
    let s = line.trim_start();
    let s = s.strip_prefix("for")?;
    let s = s
        .strip_prefix(|c: char| c.is_ascii_whitespace())?
        .trim_start();
    let ident_len = s
        .char_indices()
        .take_while(|&(i, c)| {
            if i == 0 {
                c.is_ascii_alphabetic() || c == '_'
            } else {
                c.is_ascii_alphanumeric() || c == '_'
            }
        })
        .count();
    if ident_len == 0 {
        return None;
    }
    let ident = &s[..ident_len];
    let s = s[ident_len..]
        .strip_prefix(|c: char| c.is_ascii_whitespace())?
        .trim_start();
    let s = s.strip_prefix("in")?;
    let s = s
        .strip_prefix(|c: char| c.is_ascii_whitespace())?
        .trim_start();

    // First `;` whose right side reads `\s* do \s`.
    let mut split = None;
    for (i, _) in s.match_indices(';') {
        if i == 0 {
            return None; // words must be non-empty
        }
        let after = s[i + 1..].trim_start();
        if let Some(rest) = after.strip_prefix("do")
            && rest.starts_with(|c: char| c.is_ascii_whitespace())
        {
            let body_start = s.len() - rest.trim_start().len();
            split = Some((s[..i].trim_end().to_string(), body_start));
            break;
        }
    }
    let (words, body_start) = split?;
    let rest = &s[body_start..];

    let tail_matches = |t: &str| -> bool {
        let t = t.trim_start();
        let t = t.strip_prefix(';').unwrap_or(t).trim_start();
        t.strip_prefix("done")
            .is_some_and(|after| after.trim_start().is_empty())
    };
    for end in 1..=rest.len() {
        if !rest.is_char_boundary(end) {
            continue;
        }
        if tail_matches(&rest[end..]) {
            return Some((ident.to_string(), words, rest[..end].to_string()));
        }
    }
    None
}

// ---------------------------------------------------------------------------
// parsing

enum Token {
    Word(String),
    Op(&'static str),
}

const OPS: [&str; 7] = ["&&", "||", ";", "|", ">>", ">", "<"];

struct Stage {
    argv: Vec<String>,
    input: Option<String>,
    output: Option<String>,
    append: bool,
}

impl Stage {
    fn new() -> Self {
        Stage {
            argv: Vec::new(),
            input: None,
            output: None,
            append: false,
        }
    }
}

struct Chain {
    pipeline: Vec<Stage>,
    joiner: Option<&'static str>,
}

fn parse(tokens: Vec<Token>) -> Vec<Chain> {
    let mut chains = Vec::new();
    let mut stages = Vec::new();
    let mut stage = Stage::new();
    let mut expect: Option<&'static str> = None;
    for t in tokens {
        match t {
            Token::Word(w) => match expect.take() {
                Some("in") => stage.input = Some(w),
                Some(_) => stage.output = Some(w),
                None => stage.argv.push(w),
            },
            Token::Op("<") => expect = Some("in"),
            Token::Op(">") => {
                stage.append = false;
                expect = Some("out");
            }
            Token::Op(">>") => {
                stage.append = true;
                expect = Some("out");
            }
            Token::Op("|") => stages.push(std::mem::replace(&mut stage, Stage::new())),
            Token::Op(op) => {
                stages.push(std::mem::replace(&mut stage, Stage::new()));
                chains.push(Chain {
                    pipeline: std::mem::take(&mut stages),
                    joiner: Some(op),
                });
            }
        }
    }
    stages.push(stage);
    chains.push(Chain {
        pipeline: stages,
        joiner: None,
    });
    chains.retain(|c| c.pipeline.iter().any(|s| !s.argv.is_empty()));
    chains
}

// ---------------------------------------------------------------------------
// execution

struct Heredoc {
    raw: String,
    quoted: bool,
}

struct LineResult {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    captured: Vec<u8>,
}

struct Ctx<'a, B: Backend + ?Sized, R: CommandRunner + ?Sized> {
    backend: &'a mut B,
    runner: &'a mut R,
    session: &'a mut Session,
    sub_depth: u32,
}

impl<B: Backend + ?Sized, R: CommandRunner + ?Sized> Ctx<'_, B, R> {
    fn lookup(&self, key: &str) -> String {
        if key == "?" {
            self.session.last_status.to_string()
        } else {
            self.session.env.get(key).unwrap_or("").to_string()
        }
    }

    fn expand(&self, s: &str) -> String {
        let chars: Vec<char> = s.chars().collect();
        let mut out = String::new();
        let mut i = 0;
        while i < chars.len() {
            if chars[i] == '$'
                && let Some((key, len)) = var_ref(&chars, i)
            {
                out.push_str(&self.lookup(&key));
                i += len;
            } else {
                out.push(chars[i]);
                i += 1;
            }
        }
        out
    }

    /// Expand `$( )` substitutions. Returns the rewritten line plus any
    /// stderr the substituted commands produced, so it reaches the caller.
    fn expand_subs(&mut self, line: &str) -> Result<(String, Vec<u8>), String> {
        if !line.contains("$(") {
            return Ok((line.to_string(), Vec::new()));
        }
        if self.sub_depth > 8 {
            return Err("command substitution nested too deep".to_string());
        }
        let chars: Vec<char> = line.chars().collect();
        let mut out = String::new();
        let mut errs = Vec::new();
        let mut i = 0;
        let mut sq = false;
        while i < chars.len() {
            let c = chars[i];
            if c == '\'' {
                sq = !sq;
                out.push(c);
                i += 1;
            } else if !sq && c == '$' && chars.get(i + 1) == Some(&'(') {
                let mut depth = 1;
                let mut j = i + 2;
                while j < chars.len() && depth > 0 {
                    match chars[j] {
                        '(' => depth += 1,
                        ')' => depth -= 1,
                        _ => {}
                    }
                    j += 1;
                }
                if depth > 0 {
                    return Err("unterminated $( )".to_string());
                }
                let inner: String = chars[i + 2..j - 1].iter().collect();
                self.sub_depth += 1;
                let r = self.exec_line(&inner, None, true);
                self.sub_depth -= 1;
                errs.extend_from_slice(&r.stderr);
                let text = String::from_utf8_lossy(&r.captured);
                out.push_str(&text.split_whitespace().collect::<Vec<_>>().join(" "));
                i = j;
            } else {
                out.push(c);
                i += 1;
            }
        }
        Ok((out, errs))
    }

    fn tokenize(&self, line: &str) -> Result<Vec<Token>, String> {
        let chars: Vec<char> = line.chars().collect();
        let mut tokens = Vec::new();
        let mut cur = String::new();
        let mut started = false;
        let mut i = 0;
        macro_rules! flush {
            () => {
                if std::mem::take(&mut started) {
                    tokens.push(Token::Word(std::mem::take(&mut cur)));
                } else {
                    cur.clear();
                }
            };
        }
        while i < chars.len() {
            let c = chars[i];
            if c == '\'' {
                started = true;
                let end = chars[i + 1..]
                    .iter()
                    .position(|&x| x == '\'')
                    .map(|p| p + i + 1);
                let Some(end) = end else {
                    return Err("unterminated '".to_string());
                };
                cur.extend(&chars[i + 1..end]);
                i = end + 1;
            } else if c == '"' {
                started = true;
                let mut j = i + 1;
                loop {
                    let Some(&d) = chars.get(j) else {
                        return Err("unterminated \"".to_string());
                    };
                    if d == '"' {
                        break;
                    }
                    if d == '\\'
                        && matches!(chars.get(j + 1), Some(&'"') | Some(&'$') | Some(&'\\'))
                    {
                        cur.push(chars[j + 1]);
                        j += 2;
                    } else if d == '$' {
                        if let Some((key, len)) = var_ref(&chars, j) {
                            cur.push_str(&self.lookup(&key));
                            j += len;
                        } else {
                            cur.push('$');
                            j += 1;
                        }
                    } else {
                        cur.push(d);
                        j += 1;
                    }
                }
                i = j + 1;
            } else if c == '\\' {
                started = true;
                if let Some(&next) = chars.get(i + 1) {
                    cur.push(next);
                }
                i += 2;
            } else if c == ' ' || c == '\t' {
                flush!();
                i += 1;
            } else if let Some(op) = OPS
                .iter()
                .find(|op| chars[i..].starts_with(&op.chars().collect::<Vec<_>>()))
            {
                flush!();
                tokens.push(Token::Op(op));
                i += op.len();
            } else if c == '$' {
                started = true;
                if let Some((key, len)) = var_ref(&chars, i) {
                    cur.push_str(&self.lookup(&key));
                    i += len;
                } else {
                    cur.push(c);
                    i += 1;
                }
            } else {
                started = true;
                cur.push(c);
                i += 1;
            }
        }
        flush!();
        Ok(tokens)
    }

    fn resolve_path(&self, p: &str) -> String {
        if p.starts_with('/') {
            normalize(p)
        } else {
            normalize(&format!("{}/{}", self.session.cwd, p))
        }
    }

    /// Session builtins; `None` means "not a builtin".
    fn builtin(&mut self, name: &str, args: &[String]) -> Option<CommandOutput> {
        let ok = |out: String| {
            Some(CommandOutput {
                out: out.into_bytes(),
                err: Vec::new(),
                code: 0,
            })
        };
        match name {
            ":" => ok(String::new()),
            "pwd" => ok(format!("{}\n", self.session.cwd)),
            "cd" => {
                let arg = args.first().map(String::as_str);
                let target = arg
                    .map(str::to_string)
                    .or_else(|| self.session.env.get("HOME").map(str::to_string))
                    .unwrap_or_else(|| "/".to_string());
                let resolved = if target.starts_with('/') {
                    normalize(&target)
                } else {
                    normalize(&format!("{}/{}", self.session.cwd, target))
                };
                let entry = self.backend.entry(&resolved).unwrap_or(None);
                let err = |msg: String| {
                    Some(CommandOutput {
                        out: Vec::new(),
                        err: msg.into_bytes(),
                        code: 1,
                    })
                };
                match entry {
                    None => err(format!(
                        "cd: {}: No such file or directory\n",
                        arg.unwrap_or("")
                    )),
                    Some(e) if e.kind != Kind::Dir => {
                        err(format!("cd: {}: Not a directory\n", arg.unwrap_or("")))
                    }
                    Some(_) => {
                        self.session.cwd = format!("/{resolved}");
                        ok(String::new())
                    }
                }
            }
            "export" => {
                for a in args {
                    if let Some(eq) = a.find('=')
                        && eq > 0
                    {
                        self.session.env.set(&a[..eq], &a[eq + 1..]);
                    }
                }
                ok(String::new())
            }
            "unset" => {
                for a in args {
                    self.session.env.remove(a);
                }
                ok(String::new())
            }
            "env" => {
                let mut env = self.session.env.clone();
                env.set("PWD", &self.session.cwd);
                let body: Vec<String> = env.iter().map(|(k, v)| format!("{k}={v}")).collect();
                ok(format!("{}\n", body.join("\n")))
            }
            _ => None,
        }
    }

    fn exec_line(&mut self, line: &str, heredoc: Option<&Heredoc>, capture: bool) -> LineResult {
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut captured = Vec::new();
        macro_rules! fail {
            ($msg:expr) => {{
                stderr.extend_from_slice(format!("boxsh: {}\n", $msg).as_bytes());
                self.session.last_status = 2;
                return LineResult {
                    stdout,
                    stderr,
                    captured,
                };
            }};
        }

        if let Some((var, words_src, body)) = parse_for(line) {
            let words = match self.expand_subs(&words_src) {
                Ok((s, errs)) => {
                    stderr.extend_from_slice(&errs);
                    self.expand(&s)
                }
                Err(e) => fail!(e),
            };
            for w in words.split_whitespace() {
                self.session.env.set(&var, w);
                let r = self.exec_line(&body, None, capture);
                stdout.extend_from_slice(&r.stdout);
                stderr.extend_from_slice(&r.stderr);
                if capture && !r.captured.is_empty() {
                    captured.extend_from_slice(&r.captured);
                }
            }
            return LineResult {
                stdout,
                stderr,
                captured,
            };
        }

        let expanded = match self.expand_subs(line) {
            Ok((s, errs)) => {
                stderr.extend_from_slice(&errs);
                s
            }
            Err(e) => fail!(e),
        };
        let chains = match self.tokenize(&expanded) {
            Ok(tokens) => parse(tokens),
            Err(e) => fail!(e),
        };

        let mut skip: Option<&'static str> = None;
        for Chain { pipeline, joiner } in chains {
            if skip == Some("&&") && self.session.last_status != 0 {
                skip = joiner;
                continue;
            }
            if skip == Some("||") && self.session.last_status == 0 {
                skip = joiner;
                continue;
            }
            let mut data: Vec<u8> = heredoc
                .map(|h| {
                    if h.quoted {
                        h.raw.clone().into_bytes()
                    } else {
                        self.expand(&h.raw).into_bytes()
                    }
                })
                .unwrap_or_default();
            let last = pipeline.len() - 1;
            for (s, st) in pipeline.iter().enumerate() {
                let name = st.argv.first().map(String::as_str).unwrap_or("");
                if let Some(input) = &st.input {
                    match self.backend.read(&self.resolve_path(input)) {
                        Ok(d) => data = d,
                        Err(_) => {
                            stderr.extend_from_slice(
                                format!("boxsh: {input}: No such file or directory\n").as_bytes(),
                            );
                            self.session.last_status = 1;
                            break;
                        }
                    }
                }
                let args = st.argv.get(1..).unwrap_or(&[]);
                let r = if let Some(b) = self.builtin(name, args) {
                    b
                } else if self.runner.knows(name) {
                    self.runner.run(&st.argv, &data, self.session)
                } else {
                    CommandOutput {
                        out: Vec::new(),
                        err: format!("boxsh: {name}: command not found\n").into_bytes(),
                        code: 127,
                    }
                };
                if !r.err.is_empty() {
                    stderr.extend_from_slice(&r.err);
                }
                self.session.last_status = r.code;
                data = r.out;
                if s == last {
                    if let Some(output) = &st.output {
                        let path = self.resolve_path(output);
                        let write = if st.append {
                            match self.backend.read(&path) {
                                Ok(mut existing) => {
                                    existing.extend_from_slice(&data);
                                    self.backend.write(&path, &existing)
                                }
                                Err(_) => self.backend.write(&path, &data),
                            }
                        } else {
                            self.backend.write(&path, &data)
                        };
                        if let Err(e) = write {
                            stderr.extend_from_slice(format!("boxsh: {output}: {e}\n").as_bytes());
                            self.session.last_status = 1;
                        }
                    } else if capture {
                        if !data.is_empty() {
                            captured.extend_from_slice(&data);
                        }
                    } else if !data.is_empty() {
                        stdout.extend_from_slice(&data);
                    }
                }
            }
            skip = joiner;
        }
        LineResult {
            stdout,
            stderr,
            captured,
        }
    }

    fn exec_script(&mut self, script: &str) -> ScriptResult {
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let lines: Vec<&str> = script.split('\n').collect();
        let mut i = 0;
        while i < lines.len() {
            let line = lines[i];
            if line.trim().is_empty() {
                i += 1;
                continue;
            }
            let mut cmd = line.to_string();
            let mut body = None;
            if let Some((start, end, tag, quoted)) = scan_heredoc(line) {
                cmd = format!("{}{}", &line[..start], &line[end..]);
                let mut raw = String::new();
                i += 1;
                while i < lines.len() && lines[i] != tag {
                    raw.push_str(lines[i]);
                    raw.push('\n');
                    i += 1;
                }
                body = Some(Heredoc { raw, quoted });
            }
            let r = self.exec_line(&cmd, body.as_ref(), false);
            stdout.extend_from_slice(&r.stdout);
            stderr.extend_from_slice(&r.stderr);
            i += 1;
        }
        ScriptResult {
            stdout,
            stderr,
            code: self.session.last_status,
        }
    }
}
