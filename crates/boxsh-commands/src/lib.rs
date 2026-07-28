//! In-module commands — the boxsh hot path with no boundary at all.
//!
//! Ported from the playground's hot-demo reactor, rewired from std/WASI
//! onto [`boxsh_fs::Backend`] directly: stdin arrives as a byte slice,
//! stdout/stderr are byte buffers, file access is trait calls. The shell
//! routes here first and falls back to the host engine (the uutils
//! multicall module) for everything else.
//!
//! Relative argv paths resolve against the session cwd, matching how the
//! cold commands see the world (their std resolves against `PWD`).

use boxsh_fs::{Backend, normalize};

/// Output of one command execution.
pub struct Output {
    pub out: Vec<u8>,
    pub err: Vec<u8>,
    pub code: i32,
}

/// Commands implemented in-module.
pub fn knows(name: &str) -> bool {
    matches!(
        name,
        "true" | "false" | "echo" | "cat" | "tee" | "wc" | "seq" | "head" | "sort" | "grep"
    )
}

/// Run an in-module command; `None` if `argv[0]` is not one of ours.
pub fn run(
    backend: &mut (impl Backend + ?Sized),
    cwd: &str,
    argv: &[String],
    stdin: &[u8],
) -> Option<Output> {
    let name = argv.first().map(String::as_str)?;
    if !knows(name) {
        return None;
    }
    let mut io = Io {
        backend,
        cwd,
        stdin,
        out: Vec::new(),
        err: Vec::new(),
    };
    let args = &argv[1..];
    let code = match name {
        "true" => 0,
        "false" => 1,
        "echo" => cmd_echo(&mut io, args),
        "cat" => cmd_cat(&mut io, args),
        "tee" => cmd_tee(&mut io, args),
        "wc" => cmd_wc(&mut io, args),
        "seq" => cmd_seq(&mut io, args),
        "head" => cmd_head(&mut io, args),
        "sort" => cmd_sort(&mut io, args),
        "grep" => cmd_grep(&mut io, args),
        _ => unreachable!("knows() gated"),
    };
    Some(Output {
        out: io.out,
        err: io.err,
        code,
    })
}

struct Io<'a, B: Backend + ?Sized> {
    backend: &'a mut B,
    cwd: &'a str,
    stdin: &'a [u8],
    out: Vec<u8>,
    err: Vec<u8>,
}

impl<B: Backend + ?Sized> Io<'_, B> {
    fn resolve(&self, path: &str) -> String {
        if path.starts_with('/') {
            normalize(path)
        } else {
            normalize(&format!("{}/{}", self.cwd, path))
        }
    }

    fn read_file(&mut self, path: &str) -> Result<Vec<u8>, boxsh_fs::Error> {
        let p = self.resolve(path);
        self.backend.read(&p)
    }

    fn write_file(&mut self, path: &str, data: &[u8]) -> Result<(), boxsh_fs::Error> {
        let p = self.resolve(path);
        self.backend.write(&p, data)
    }

    fn errln(&mut self, msg: &str) {
        self.err.extend_from_slice(msg.as_bytes());
        self.err.push(b'\n');
    }
}

fn cmd_echo<B: Backend + ?Sized>(io: &mut Io<'_, B>, args: &[String]) -> i32 {
    let (no_newline, rest) = match args.first().map(String::as_str) {
        Some("-n") => (true, &args[1..]),
        _ => (false, args),
    };
    io.out.extend_from_slice(rest.join(" ").as_bytes());
    if !no_newline {
        io.out.push(b'\n');
    }
    0
}

fn cmd_cat<B: Backend + ?Sized>(io: &mut Io<'_, B>, args: &[String]) -> i32 {
    if args.is_empty() {
        let stdin = io.stdin.to_vec();
        io.out.extend_from_slice(&stdin);
        return 0;
    }
    for f in args {
        match io.read_file(f) {
            Ok(d) => io.out.extend_from_slice(&d),
            Err(e) => {
                io.errln(&format!("cat: {f}: {e}"));
                return 1;
            }
        }
    }
    0
}

fn cmd_tee<B: Backend + ?Sized>(io: &mut Io<'_, B>, args: &[String]) -> i32 {
    let (append, files) = match args.first().map(String::as_str) {
        Some("-a") => (true, &args[1..]),
        _ => (false, args),
    };
    let data = io.stdin.to_vec();
    for f in files {
        let payload = if append {
            match io.read_file(f) {
                Ok(mut existing) => {
                    existing.extend_from_slice(&data);
                    existing
                }
                Err(_) => data.clone(),
            }
        } else {
            data.clone()
        };
        if let Err(e) = io.write_file(f, &payload) {
            io.errln(&format!("tee: {f}: {e}"));
            return 1;
        }
    }
    io.out.extend_from_slice(&data);
    0
}

fn counts(data: &[u8]) -> (usize, usize, usize) {
    let lines = data.iter().filter(|&&b| b == b'\n').count();
    let words = data
        .split(|b| b.is_ascii_whitespace())
        .filter(|w| !w.is_empty())
        .count();
    (lines, words, data.len())
}

fn cmd_wc<B: Backend + ?Sized>(io: &mut Io<'_, B>, args: &[String]) -> i32 {
    let (mut l, mut w, mut c) = (false, false, false);
    let mut files: Vec<&String> = Vec::new();
    for a in args {
        match a.as_str() {
            "-l" => l = true,
            "-w" => w = true,
            "-c" => c = true,
            _ => files.push(a),
        }
    }
    if !(l || w || c) {
        (l, w, c) = (true, true, true);
    }
    let emit = |io: &mut Io<'_, B>, data: &[u8], name: Option<&str>| {
        let (nl, nw, nc) = counts(data);
        let mut parts: Vec<String> = Vec::new();
        if l {
            parts.push(nl.to_string());
        }
        if w {
            parts.push(nw.to_string());
        }
        if c {
            parts.push(nc.to_string());
        }
        let mut s = parts.join(" ");
        if let Some(n) = name {
            s.push(' ');
            s.push_str(n);
        }
        s.push('\n');
        io.out.extend_from_slice(s.as_bytes());
    };
    if files.is_empty() {
        let stdin = io.stdin.to_vec();
        emit(io, &stdin, None);
        return 0;
    }
    for f in files {
        match io.read_file(f) {
            Ok(d) => emit(io, &d, Some(f)),
            Err(e) => {
                io.errln(&format!("wc: {f}: {e}"));
                return 1;
            }
        }
    }
    0
}

fn cmd_seq<B: Backend + ?Sized>(io: &mut Io<'_, B>, args: &[String]) -> i32 {
    let nums: Vec<i64> = args.iter().filter_map(|a| a.parse().ok()).collect();
    let (first, step, last) = match nums.len() {
        1 => (1, 1, nums[0]),
        2 => (nums[0], 1, nums[1]),
        3 => (nums[0], nums[1], nums[2]),
        _ => {
            io.errln("seq: bad arguments");
            return 2;
        }
    };
    if step == 0 {
        io.errln("seq: step must be non-zero");
        return 2;
    }
    let mut s = String::new();
    let mut i = first;
    while (step > 0 && i <= last) || (step < 0 && i >= last) {
        s.push_str(&i.to_string());
        s.push('\n');
        i += step;
    }
    io.out.extend_from_slice(s.as_bytes());
    0
}

fn cmd_head<B: Backend + ?Sized>(io: &mut Io<'_, B>, args: &[String]) -> i32 {
    let mut n: usize = 10;
    let mut files: Vec<&String> = Vec::new();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if a == "-n" {
            n = it.next().and_then(|v| v.parse().ok()).unwrap_or(10);
        } else if let Some(num) = a
            .strip_prefix('-')
            .filter(|r| !r.is_empty() && r.chars().all(|c| c.is_ascii_digit()))
        {
            n = num.parse().unwrap_or(10);
        } else {
            files.push(a);
        }
    }
    let emit = |io: &mut Io<'_, B>, data: &[u8]| {
        let mut end = 0;
        let mut seen = 0;
        for (i, &b) in data.iter().enumerate() {
            if b == b'\n' {
                seen += 1;
                if seen == n {
                    end = i + 1;
                    break;
                }
            }
        }
        if seen < n {
            end = data.len();
        }
        io.out.extend_from_slice(&data[..end]);
    };
    if files.is_empty() {
        let stdin = io.stdin.to_vec();
        emit(io, &stdin);
        return 0;
    }
    for f in files {
        match io.read_file(f) {
            Ok(d) => emit(io, &d),
            Err(e) => {
                io.errln(&format!("head: {f}: {e}"));
                return 1;
            }
        }
    }
    0
}

fn cmd_sort<B: Backend + ?Sized>(io: &mut Io<'_, B>, args: &[String]) -> i32 {
    let reverse = args.iter().any(|a| a == "-r");
    let files: Vec<&String> = args.iter().filter(|a| !a.starts_with('-')).collect();
    let data = if files.is_empty() {
        io.stdin.to_vec()
    } else {
        let mut d = Vec::new();
        for f in files {
            match io.read_file(f) {
                Ok(b) => d.extend_from_slice(&b),
                Err(e) => {
                    io.errln(&format!("sort: {f}: {e}"));
                    return 1;
                }
            }
        }
        d
    };
    let mut lines: Vec<&[u8]> = data.split(|&b| b == b'\n').collect();
    if data.last() == Some(&b'\n') {
        lines.pop();
    }
    lines.sort_unstable();
    if reverse {
        lines.reverse();
    }
    let mut out = Vec::with_capacity(data.len() + 1);
    for line in lines {
        out.extend_from_slice(line);
        out.push(b'\n');
    }
    io.out.extend_from_slice(&out);
    0
}

fn cmd_grep<B: Backend + ?Sized>(io: &mut Io<'_, B>, args: &[String]) -> i32 {
    let (mut count_only, mut ignore_case, mut line_numbers, mut invert) =
        (false, false, false, false);
    let mut pattern: Option<&String> = None;
    let mut files: Vec<&String> = Vec::new();
    for a in args {
        if a.starts_with('-') && a.len() > 1 && pattern.is_none() {
            for ch in a[1..].chars() {
                match ch {
                    'c' => count_only = true,
                    'i' => ignore_case = true,
                    'n' => line_numbers = true,
                    'v' => invert = true,
                    _ => {
                        io.errln(&format!("grep: invalid option -- '{ch}'"));
                        return 2;
                    }
                }
            }
        } else if pattern.is_none() {
            pattern = Some(a);
        } else {
            files.push(a);
        }
    }
    let Some(pat) = pattern else {
        io.errln("usage: grep [-cinv] PATTERN [FILE...]");
        return 2;
    };
    let re = match regex_lite::RegexBuilder::new(pat)
        .case_insensitive(ignore_case)
        .build()
    {
        Ok(r) => r,
        Err(e) => {
            io.errln(&format!("grep: invalid pattern: {e}"));
            return 2;
        }
    };
    let inputs: Vec<(String, Vec<u8>)> = if files.is_empty() {
        vec![("(standard input)".into(), io.stdin.to_vec())]
    } else {
        let mut v = Vec::new();
        for f in files {
            match io.read_file(f) {
                Ok(b) => v.push((f.to_string(), b)),
                Err(e) => {
                    io.errln(&format!("grep: {f}: {e}"));
                    return 2;
                }
            }
        }
        v
    };
    let multi = inputs.len() > 1;
    let mut any = false;
    for (name, data) in &inputs {
        let mut lines: Vec<&[u8]> = data.split(|&b| b == b'\n').collect();
        if data.last() == Some(&b'\n') {
            lines.pop();
        }
        let mut count: u64 = 0;
        for (i, line) in lines.iter().enumerate() {
            let text = String::from_utf8_lossy(line);
            if re.is_match(&text) != invert {
                any = true;
                count += 1;
                if !count_only {
                    if multi {
                        io.out.extend_from_slice(name.as_bytes());
                        io.out.push(b':');
                    }
                    if line_numbers {
                        io.out.extend_from_slice(format!("{}:", i + 1).as_bytes());
                    }
                    io.out.extend_from_slice(line);
                    io.out.push(b'\n');
                }
            }
        }
        if count_only {
            if multi {
                io.out.extend_from_slice(name.as_bytes());
                io.out.push(b':');
            }
            io.out.extend_from_slice(format!("{count}\n").as_bytes());
        }
    }
    if any { 0 } else { 1 }
}

#[cfg(test)]
mod tests {
    use super::*;
    use boxsh_fs::MemoryBackend;

    fn run_cmd(b: &mut MemoryBackend, cwd: &str, argv: &[&str], stdin: &[u8]) -> Output {
        let argv: Vec<String> = argv.iter().map(|s| s.to_string()).collect();
        run(b, cwd, &argv, stdin).expect("known command")
    }

    fn out(b: &mut MemoryBackend, cwd: &str, argv: &[&str], stdin: &[u8]) -> String {
        String::from_utf8(run_cmd(b, cwd, argv, stdin).out).unwrap()
    }

    #[test]
    fn routing_and_unknowns() {
        let mut b = MemoryBackend::new();
        assert!(knows("grep"));
        assert!(!knows("ls"));
        assert!(run(&mut b, "/", &["ls".to_string()], b"").is_none());
    }

    #[test]
    fn echo_seq_wc_head_sort() {
        let mut b = MemoryBackend::new();
        assert_eq!(out(&mut b, "/", &["echo", "a", "b"], b""), "a b\n");
        assert_eq!(out(&mut b, "/", &["echo", "-n", "x"], b""), "x");
        assert_eq!(out(&mut b, "/", &["seq", "3"], b""), "1\n2\n3\n");
        assert_eq!(out(&mut b, "/", &["seq", "5", "-2", "1"], b""), "5\n3\n1\n");
        assert_eq!(out(&mut b, "/", &["wc", "-l"], b"a\nb\n"), "2\n");
        assert_eq!(out(&mut b, "/", &["head", "-2"], b"1\n2\n3\n"), "1\n2\n");
        assert_eq!(out(&mut b, "/", &["head", "-n", "1"], b"x\ny\n"), "x\n");
        assert_eq!(out(&mut b, "/", &["sort", "-r"], b"a\nc\nb\n"), "c\nb\na\n");
    }

    #[test]
    fn file_commands_resolve_against_cwd() {
        let mut b = MemoryBackend::new();
        b.mkdir("work").unwrap();
        b.write("work/f.txt", b"from file\n").unwrap();

        assert_eq!(out(&mut b, "/work", &["cat", "f.txt"], b""), "from file\n");
        assert_eq!(
            out(&mut b, "/", &["cat", "/work/f.txt"], b""),
            "from file\n"
        );
        assert_eq!(
            out(&mut b, "/work", &["wc", "-c", "f.txt"], b""),
            "10 f.txt\n"
        );

        let r = run_cmd(&mut b, "/work", &["cat", "missing.txt"], b"");
        assert_eq!(r.code, 1);
        assert!(String::from_utf8(r.err).unwrap().contains("missing.txt"));
    }

    #[test]
    fn tee_writes_and_appends() {
        let mut b = MemoryBackend::new();
        assert_eq!(out(&mut b, "/", &["tee", "t.txt"], b"one\n"), "one\n");
        assert_eq!(b.read("t.txt").unwrap(), b"one\n");
        out(&mut b, "/", &["tee", "-a", "t.txt"], b"two\n");
        assert_eq!(b.read("t.txt").unwrap(), b"one\ntwo\n");
    }

    #[test]
    fn grep_flags() {
        let mut b = MemoryBackend::new();
        let text = b"alpha\nBeta\ngamma beta\n";
        assert_eq!(out(&mut b, "/", &["grep", "beta"], text), "gamma beta\n");
        assert_eq!(
            out(&mut b, "/", &["grep", "-i", "beta"], text),
            "Beta\ngamma beta\n"
        );
        assert_eq!(out(&mut b, "/", &["grep", "-c", "a"], text), "3\n");
        assert_eq!(
            out(&mut b, "/", &["grep", "-n", "alpha"], text),
            "1:alpha\n"
        );
        assert_eq!(
            out(&mut b, "/", &["grep", "-v", "alpha"], text),
            "Beta\ngamma beta\n"
        );
        let r = run_cmd(&mut b, "/", &["grep", "zzz"], text);
        assert_eq!(r.code, 1); // no match
        assert_eq!(run_cmd(&mut b, "/", &["grep", "^gam"], text).code, 0);
    }
}
