# Shell syntax and available commands

`Sandbox.exec()` accepts a focused shell language. It is designed for common
command workflows, not complete Bash compatibility.

## Shell syntax

| Feature | Example |
| --- | --- |
| Pipelines | `cat input.txt \| sort \| uniq` |
| Output redirection | `printf "hello\n" > output.txt` |
| Append redirection | `printf "more\n" >> output.txt` |
| Input redirection | `wc -l < input.txt` |
| Success condition | `mkdir output && echo ready` |
| Failure condition | `cat missing \|\| echo unavailable` |
| Command lists | `mkdir src; touch src/index.js` |
| Variables | `echo "$HOME"` and `echo "$?"` |
| Command substitution | `echo "files: $(ls \| wc -l)"` |
| Simple loops | `for n in 1 2 3; do echo $n; done` |
| Heredocs | `cat <<EOF > message.txt` |
| Quotes and escapes | `'literal'`, `"hello $USER"`, and `hello\ world` |

Scripts may contain multiple lines:

```js
const result = await sandbox.exec(`
  mkdir -p reports
  printf "pear\\napple\\nbanana\\n" |
    sort > reports/fruits.txt
  wc -l < reports/fruits.txt
`);
```

## Built-ins

The shell provides:

- `:`
- `cd`
- `env`
- `export`
- `pwd`
- `unset`

Changes made by `cd`, `export`, and `unset` persist across later `exec()` calls
on the same `Sandbox`.

## Commands

The required command module provides:

`arch`, `b2sum`, `base32`, `base64`, `basename`, `basenc`, `cat`, `cksum`,
`comm`, `cp`, `csplit`, `cut`, `date`, `dd`, `dir`, `dircolors`, `dirname`,
`echo`, `expand`, `factor`, `false`, `fmt`, `fold`, `grep`, `head`, `join`,
`link`, `ln`, `ls`, `md5sum`, `mkdir`, `mktemp`, `mv`, `nl`, `nproc`,
`numfmt`, `od`, `paste`, `pathchk`, `pr`, `printenv`, `printf`, `ptx`, `pwd`,
`readlink`, `realpath`, `rm`, `rmdir`, `seq`, `sha1sum`, `sha224sum`,
`sha256sum`, `sha384sum`, `sha512sum`, `shred`, `shuf`, `sleep`, `sort`,
`split`, `sum`, `tail`, `tee`, `touch`, `tr`, `true`, `truncate`, `tsort`,
`uname`, `unexpand`, `uniq`, `unlink`, `vdir`, `wc`, and `yes`.

Command and flag coverage is not a promise of complete GNU Coreutils
compatibility.

## Optional command module

When `optimizedCommands` is supplied to `loadEngine()`, the following common
commands use a focused option set:

| Command | Supported forms and options |
| --- | --- |
| `true`, `false` | No options |
| `echo` | `-n` |
| `cat` | Files or standard input |
| `tee` | `-a` and one or more files |
| `wc` | `-l`, `-w`, and `-c` |
| `seq` | `LAST`, `FIRST LAST`, or `FIRST STEP LAST` with integers |
| `head` | `-n COUNT` or `-COUNT` |
| `sort` | `-r` |
| `grep` | `-c`, `-i`, `-n`, and `-v` |

Omit `optimizedCommands` if the wider option coverage of the required command
module is more important than the optional fast paths.

## Exit and output behavior

- A missing command returns exit code `127`.
- Non-zero command exits are returned through `ExecOutput.code`.
- Standard output and standard error are available as both strings and bytes.
- The environment variable `$?` expands to the most recent exit code.
- Pipelines and `exec()` output are buffered in memory.

## Current limitations

- The shell is not Bash and does not run arbitrary Bash scripts.
- Globbing, shell functions, arrays, aliases, and job control are unavailable.
- Background processes and interactive programs are unavailable.
- Process substitution such as `<(command)` is unavailable.
- Command substitution collapses whitespace in captured output.
- Pipelines buffer each stage, so they are not intended for unbounded streams.
- The built-in memory backend is cleared when its JavaScript runtime ends.

More edge cases and practical patterns are collected in
[Recipes, behavior, and current quirks](behavior.md).
