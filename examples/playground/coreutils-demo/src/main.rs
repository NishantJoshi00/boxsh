use std::ffi::OsString;
fn main() {
    // wasi-libc emulates cwd in userspace; seed it from PWD so relative
    // paths resolve against the shell's cwd instead of "/".
    if let Ok(pwd) = std::env::var("PWD") {
        let _ = std::env::set_current_dir(&pwd);
    }
    let mut args: Vec<OsString> = std::env::args_os().collect();
    if args.len() < 2 { eprintln!("a command is required"); std::process::exit(2); }
    let rest = args.split_off(1);
    let cmd = rest[0].to_string_lossy().into_owned();
    let code = match cmd.as_str() {
        "grep" => grep(&rest),
        "arch" => uu_arch::uumain(rest.into_iter()),
        "b2sum" => uu_b2sum::uumain(rest.into_iter()),
        "base32" => uu_base32::uumain(rest.into_iter()),
        "base64" => uu_base64::uumain(rest.into_iter()),
        "basename" => uu_basename::uumain(rest.into_iter()),
        "basenc" => uu_basenc::uumain(rest.into_iter()),
        "cat" => uu_cat::uumain(rest.into_iter()),
        "cksum" => uu_cksum::uumain(rest.into_iter()),
        "comm" => uu_comm::uumain(rest.into_iter()),
        "cp" => uu_cp::uumain(rest.into_iter()),
        "csplit" => uu_csplit::uumain(rest.into_iter()),
        "cut" => uu_cut::uumain(rest.into_iter()),
        "date" => uu_date::uumain(rest.into_iter()),
        "dd" => uu_dd::uumain(rest.into_iter()),
        "dir" => uu_dir::uumain(rest.into_iter()),
        "dircolors" => uu_dircolors::uumain(rest.into_iter()),
        "dirname" => uu_dirname::uumain(rest.into_iter()),
        "echo" => uu_echo::uumain(rest.into_iter()),
        "expand" => uu_expand::uumain(rest.into_iter()),
        "factor" => uu_factor::uumain(rest.into_iter()),
        "false" => uu_false::uumain(rest.into_iter()),
        "fmt" => uu_fmt::uumain(rest.into_iter()),
        "fold" => uu_fold::uumain(rest.into_iter()),
        "head" => uu_head::uumain(rest.into_iter()),
        "join" => uu_join::uumain(rest.into_iter()),
        "link" => uu_link::uumain(rest.into_iter()),
        "ln" => uu_ln::uumain(rest.into_iter()),
        "ls" => uu_ls::uumain(rest.into_iter()),
        "md5sum" => uu_md5sum::uumain(rest.into_iter()),
        "mkdir" => uu_mkdir::uumain(rest.into_iter()),
        "mktemp" => uu_mktemp::uumain(rest.into_iter()),
        "mv" => uu_mv::uumain(rest.into_iter()),
        "nl" => uu_nl::uumain(rest.into_iter()),
        "nproc" => uu_nproc::uumain(rest.into_iter()),
        "numfmt" => uu_numfmt::uumain(rest.into_iter()),
        "od" => uu_od::uumain(rest.into_iter()),
        "paste" => uu_paste::uumain(rest.into_iter()),
        "pathchk" => uu_pathchk::uumain(rest.into_iter()),
        "pr" => uu_pr::uumain(rest.into_iter()),
        "printenv" => uu_printenv::uumain(rest.into_iter()),
        "printf" => uu_printf::uumain(rest.into_iter()),
        "ptx" => uu_ptx::uumain(rest.into_iter()),
        "pwd" => uu_pwd::uumain(rest.into_iter()),
        "readlink" => uu_readlink::uumain(rest.into_iter()),
        "realpath" => uu_realpath::uumain(rest.into_iter()),
        "rm" => uu_rm::uumain(rest.into_iter()),
        "rmdir" => uu_rmdir::uumain(rest.into_iter()),
        "seq" => uu_seq::uumain(rest.into_iter()),
        "sha1sum" => uu_sha1sum::uumain(rest.into_iter()),
        "sha224sum" => uu_sha224sum::uumain(rest.into_iter()),
        "sha256sum" => uu_sha256sum::uumain(rest.into_iter()),
        "sha384sum" => uu_sha384sum::uumain(rest.into_iter()),
        "sha512sum" => uu_sha512sum::uumain(rest.into_iter()),
        "shred" => uu_shred::uumain(rest.into_iter()),
        "shuf" => uu_shuf::uumain(rest.into_iter()),
        "sleep" => uu_sleep::uumain(rest.into_iter()),
        "sort" => uu_sort::uumain(rest.into_iter()),
        "split" => uu_split::uumain(rest.into_iter()),
        "sum" => uu_sum::uumain(rest.into_iter()),
        "tail" => uu_tail::uumain(rest.into_iter()),
        "tee" => uu_tee::uumain(rest.into_iter()),
        "touch" => uu_touch::uumain(rest.into_iter()),
        "tr" => uu_tr::uumain(rest.into_iter()),
        "true" => uu_true::uumain(rest.into_iter()),
        "truncate" => uu_truncate::uumain(rest.into_iter()),
        "tsort" => uu_tsort::uumain(rest.into_iter()),
        "uname" => uu_uname::uumain(rest.into_iter()),
        "unexpand" => uu_unexpand::uumain(rest.into_iter()),
        "uniq" => uu_uniq::uumain(rest.into_iter()),
        "unlink" => uu_unlink::uumain(rest.into_iter()),
        "vdir" => uu_vdir::uumain(rest.into_iter()),
        "wc" => uu_wc::uumain(rest.into_iter()),
        "yes" => uu_yes::uumain(rest.into_iter()),
        _ => { eprintln!("{cmd}: command not found"); 127 }
    };
    std::process::exit(code);
}

// Native grep — M4 preview (not in coreutils; the real one lands as a nobox
// native command). Byte-safe via regex::bytes. Flags: -c -i -n -v.
fn grep(args: &[OsString]) -> i32 {
    use std::io::{Read, Write};
    let (mut count_only, mut ignore_case, mut line_numbers, mut invert) = (false, false, false, false);
    let mut pattern: Option<String> = None;
    let mut files: Vec<String> = Vec::new();
    for a in &args[1..] {
        let s = a.to_string_lossy();
        if s.starts_with('-') && s.len() > 1 && pattern.is_none() {
            for ch in s[1..].chars() {
                match ch {
                    'c' => count_only = true,
                    'i' => ignore_case = true,
                    'n' => line_numbers = true,
                    'v' => invert = true,
                    _ => { eprintln!("grep: invalid option -- '{ch}'"); return 2; }
                }
            }
        } else if pattern.is_none() {
            pattern = Some(s.into_owned());
        } else {
            files.push(s.into_owned());
        }
    }
    let Some(pat) = pattern else { eprintln!("usage: grep [-cinv] PATTERN [FILE...]"); return 2; };
    let re = match regex::bytes::RegexBuilder::new(&pat).case_insensitive(ignore_case).build() {
        Ok(r) => r,
        Err(e) => { eprintln!("grep: invalid pattern: {e}"); return 2; }
    };
    let inputs: Vec<(String, Vec<u8>)> = if files.is_empty() {
        let mut buf = Vec::new();
        if std::io::stdin().read_to_end(&mut buf).is_err() { eprintln!("grep: read error"); return 2; }
        vec![("(standard input)".into(), buf)]
    } else {
        let mut v = Vec::new();
        for f in files {
            match std::fs::read(&f) {
                Ok(b) => v.push((f, b)),
                Err(e) => { eprintln!("grep: {f}: {e}"); return 2; }
            }
        }
        v
    };
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    let multi = inputs.len() > 1;
    let mut any = false;
    for (name, data) in &inputs {
        let mut lines: Vec<&[u8]> = data.split(|&b| b == b'\n').collect();
        if data.last() == Some(&b'\n') { lines.pop(); }
        let mut count: u64 = 0;
        for (i, line) in lines.iter().enumerate() {
            if re.is_match(line) != invert {
                any = true;
                count += 1;
                if !count_only {
                    if multi { let _ = write!(out, "{name}:"); }
                    if line_numbers { let _ = write!(out, "{}:", i + 1); }
                    let _ = out.write_all(line);
                    let _ = out.write_all(b"\n");
                }
            }
        }
        if count_only {
            if multi { let _ = write!(out, "{name}:"); }
            let _ = writeln!(out, "{count}");
        }
    }
    if any { 0 } else { 1 }
}
