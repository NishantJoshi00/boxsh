//! Optimized command implementations for the boxsh browser playground.

use std::io::{Read, Write};

fn read_stdin() -> Vec<u8> {
    // Fresh unbuffered handle per call: std::io::stdin()'s process-global
    // BufReader would leak buffered bytes across warm calls.
    use std::os::fd::FromRawFd;
    let mut f = unsafe { std::fs::File::from_raw_fd(0) };
    let mut buf = Vec::new();
    let _ = f.read_to_end(&mut buf);
    std::mem::forget(f); // fd 0 is not ours to close
    buf
}

fn out_all(data: &[u8]) {
    let stdout = std::io::stdout();
    let mut o = stdout.lock();
    let _ = o.write_all(data);
}

#[unsafe(no_mangle)]
pub extern "C" fn hot_alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len);
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// # Safety
/// `ptr` must come from `hot_alloc(len)` with this exact `len`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hot_free(ptr: *mut u8, len: usize) {
    if !ptr.is_null() {
        drop(unsafe { Vec::from_raw_parts(ptr, 0, len) });
    }
}

/// Set the working directory used by subsequent commands.
#[unsafe(no_mangle)]
pub extern "C" fn hot_chdir(ptr: *const u8, len: usize) -> i32 {
    let raw = unsafe { std::slice::from_raw_parts(ptr, len) };
    match std::str::from_utf8(raw) {
        Ok(p) => match std::env::set_current_dir(p) {
            Ok(()) => 0,
            Err(_) => 1,
        },
        Err(_) => 1,
    }
}

/// argv as NUL-separated bytes. Returns the exit code.
#[unsafe(no_mangle)]
pub extern "C" fn hot_run(ptr: *const u8, len: usize) -> i32 {
    let raw = unsafe { std::slice::from_raw_parts(ptr, len) };
    let argv: Vec<String> = raw
        .split(|&b| b == 0)
        .filter(|s| !s.is_empty())
        .map(|s| String::from_utf8_lossy(s).into_owned())
        .collect();
    if argv.is_empty() {
        return 2;
    }
    let code = match argv[0].as_str() {
        "true" => 0,
        "false" => 1,
        "echo" => cmd_echo(&argv[1..]),
        "cat" => cmd_cat(&argv[1..]),
        "tee" => cmd_tee(&argv[1..]),
        "wc" => cmd_wc(&argv[1..]),
        "seq" => cmd_seq(&argv[1..]),
        "head" => cmd_head(&argv[1..]),
        "sort" => cmd_sort(&argv[1..]),
        "grep" => cmd_grep(&argv[1..]),
        other => {
            eprintln!("{other}: command not found");
            127
        }
    };
    let _ = std::io::stdout().flush();
    let _ = std::io::stderr().flush();
    code
}

fn cmd_echo(args: &[String]) -> i32 {
    let (no_newline, rest) = match args.first().map(String::as_str) {
        Some("-n") => (true, &args[1..]),
        _ => (false, args),
    };
    let mut s = rest.join(" ");
    if !no_newline {
        s.push('\n');
    }
    out_all(s.as_bytes());
    0
}

fn cmd_cat(args: &[String]) -> i32 {
    if args.is_empty() {
        out_all(&read_stdin());
        return 0;
    }
    for f in args {
        match std::fs::read(f) {
            Ok(d) => out_all(&d),
            Err(e) => {
                eprintln!("cat: {f}: {e}");
                return 1;
            }
        }
    }
    0
}

fn cmd_tee(args: &[String]) -> i32 {
    let (append, files) = match args.first().map(String::as_str) {
        Some("-a") => (true, &args[1..]),
        _ => (false, args),
    };
    let data = read_stdin();
    for f in files {
        let r = if append {
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(f)
                .and_then(|mut fh| fh.write_all(&data))
        } else {
            std::fs::write(f, &data)
        };
        if let Err(e) = r {
            eprintln!("tee: {f}: {e}");
            return 1;
        }
    }
    out_all(&data);
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

fn cmd_wc(args: &[String]) -> i32 {
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
    let emit = |data: &[u8], name: Option<&str>| {
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
        out_all(s.as_bytes());
    };
    if files.is_empty() {
        emit(&read_stdin(), None);
        return 0;
    }
    for f in &files {
        match std::fs::read(f) {
            Ok(d) => emit(&d, Some(f)),
            Err(e) => {
                eprintln!("wc: {f}: {e}");
                return 1;
            }
        }
    }
    0
}

fn cmd_seq(args: &[String]) -> i32 {
    let nums: Vec<i64> = args.iter().filter_map(|a| a.parse().ok()).collect();
    let (first, step, last) = match nums.len() {
        1 => (1, 1, nums[0]),
        2 => (nums[0], 1, nums[1]),
        3 => (nums[0], nums[1], nums[2]),
        _ => {
            eprintln!("seq: bad arguments");
            return 2;
        }
    };
    if step == 0 {
        eprintln!("seq: step must be non-zero");
        return 2;
    }
    let mut s = String::new();
    let mut i = first;
    while (step > 0 && i <= last) || (step < 0 && i >= last) {
        s.push_str(&i.to_string());
        s.push('\n');
        i += step;
    }
    out_all(s.as_bytes());
    0
}

fn cmd_head(args: &[String]) -> i32 {
    let mut n: usize = 10;
    let mut files: Vec<&String> = Vec::new();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if a == "-n" {
            n = it.next().and_then(|v| v.parse().ok()).unwrap_or(10);
        } else if let Some(num) = a.strip_prefix('-').filter(|r| r.chars().all(|c| c.is_ascii_digit())) {
            n = num.parse().unwrap_or(10);
        } else {
            files.push(a);
        }
    }
    let emit = |data: &[u8]| {
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
        out_all(&data[..end]);
    };
    if files.is_empty() {
        emit(&read_stdin());
        return 0;
    }
    for f in &files {
        match std::fs::read(f) {
            Ok(d) => emit(&d),
            Err(e) => {
                eprintln!("head: {f}: {e}");
                return 1;
            }
        }
    }
    0
}

fn cmd_sort(args: &[String]) -> i32 {
    let reverse = args.iter().any(|a| a == "-r");
    let files: Vec<&String> = args.iter().filter(|a| !a.starts_with('-')).collect();
    let data = if files.is_empty() {
        read_stdin()
    } else {
        let mut d = Vec::new();
        for f in &files {
            match std::fs::read(f) {
                Ok(b) => d.extend_from_slice(&b),
                Err(e) => {
                    eprintln!("sort: {f}: {e}");
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
    out_all(&out);
    0
}

fn cmd_grep(args: &[String]) -> i32 {
    let (mut count_only, mut ignore_case, mut line_numbers, mut invert) = (false, false, false, false);
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
                        eprintln!("grep: invalid option -- '{ch}'");
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
        eprintln!("usage: grep [-cinv] PATTERN [FILE...]");
        return 2;
    };
    let re = match regex::bytes::RegexBuilder::new(pat)
        .case_insensitive(ignore_case)
        .build()
    {
        Ok(r) => r,
        Err(e) => {
            eprintln!("grep: invalid pattern: {e}");
            return 2;
        }
    };
    let inputs: Vec<(String, Vec<u8>)> = if files.is_empty() {
        vec![("(standard input)".into(), read_stdin())]
    } else {
        let mut v = Vec::new();
        for f in files {
            match std::fs::read(f) {
                Ok(b) => v.push((f.clone(), b)),
                Err(e) => {
                    eprintln!("grep: {f}: {e}");
                    return 2;
                }
            }
        }
        v
    };
    let stdout = std::io::stdout();
    let mut o = stdout.lock();
    let multi = inputs.len() > 1;
    let mut any = false;
    for (name, data) in &inputs {
        let mut lines: Vec<&[u8]> = data.split(|&b| b == b'\n').collect();
        if data.last() == Some(&b'\n') {
            lines.pop();
        }
        let mut count: u64 = 0;
        for (i, line) in lines.iter().enumerate() {
            if re.is_match(line) != invert {
                any = true;
                count += 1;
                if !count_only {
                    if multi {
                        let _ = write!(o, "{name}:");
                    }
                    if line_numbers {
                        let _ = write!(o, "{}:", i + 1);
                    }
                    let _ = o.write_all(line);
                    let _ = o.write_all(b"\n");
                }
            }
        }
        if count_only {
            if multi {
                let _ = write!(o, "{name}:");
            }
            let _ = writeln!(o, "{count}");
        }
    }
    if any { 0 } else { 1 }
}
