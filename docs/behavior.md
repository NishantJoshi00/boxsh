# Recipes, behavior, and current quirks

This guide records useful patterns and observable behavior that is too detailed
for the README. It describes the current `0.0.x` release line and may change
before a stable release.

## Recipes

### Share files without sharing shell state

Multiple sandboxes can use the same `Filesystem`. They see the same files while
keeping separate working directories, environments, and exit status.

```js
const filesystem = await Filesystem.create({ backend: memory() });
await filesystem.mkdir("/shared");

const writer = new Sandbox({
  fs: filesystem,
  engine,
  cwd: "/shared",
  env: {
    HOME: "/shared",
    USER: "writer",
    PATH: "/usr/local/bin:/usr/bin:/bin",
    LANG: "C.UTF-8",
  },
});

const reader = new Sandbox({
  fs: filesystem,
  engine,
  cwd: "/",
});

await writer.exec("printf 'hello\\n' > message.txt");
const result = await reader.exec("cat /shared/message.txt");
```

`writer.env` and `writer.cwd` do not affect `reader`, but both sandboxes observe
changes to `filesystem`.

### Keep command modules and workspaces separate

A `NoboxEngine` can be reused by multiple sandboxes. Each sandbox may use a
different filesystem:

```js
const firstFilesystem = await Filesystem.create({ backend: memory() });
const secondFilesystem = await Filesystem.create({ backend: memory() });

const first = new Sandbox({ fs: firstFilesystem, engine });
const second = new Sandbox({ fs: secondFilesystem, engine });
```

This avoids loading the command modules again while keeping workspace data
separate.

### Preserve binary output

Use the byte properties when command output is not UTF-8:

```js
const result = await sandbox.exec("cat /workspace/image.bin");

if (result.code === 0) {
  consumeBytes(result.stdoutBytes);
}
```

`stdout` and `stderr` are decoded text conveniences. Invalid UTF-8 sequences
may be replaced during decoding; `stdoutBytes` and `stderrBytes` preserve the
original bytes.

### Snapshot and restore a workspace

```js
const archive = await filesystem.export();

const restored = await Filesystem.create({ backend: memory() });
await restored.import(archive);
```

TAR export is useful for moving file contents and directory structure between
filesystems. See [TAR archives](#tar-archives) before using it for backups or
untrusted input.

### Change storage without recreating sandboxes

```js
const sandbox = new Sandbox({ fs: filesystem, engine });

await filesystem.switchBackend(nextBackend);

// The existing sandbox now uses nextBackend.
await sandbox.exec("cat /workspace/existing.txt");
```

The filesystem object remains stable, so sandboxes created from it follow a
successful backend switch.

## Filesystem behavior

### Paths

Public filesystem methods accept paths with or without a leading slash.
Normalization:

- Removes empty segments and `.`
- Resolves `..`
- Prevents `..` from moving above the virtual root
- Represents the root as an empty string when calling a backend

```js
normalize("/a/./b/../c"); // "a/c"
normalize("../../a");     // "a"
normalize("/");           // ""
```

Storage backend implementations receive normalized paths without a leading
slash.

### Parent directories

`writeFile()` does not create parent directories:

```js
await filesystem.mkdir("/reports", { recursive: true });
await filesystem.writeFile("/reports/result.txt", "done\n");
```

Use `mkdir(..., { recursive: true })` before writing nested paths.

### Directory ordering

`readdir()` sorts entries by name before returning them. Command output may
apply its own ordering rules.

### Byte-array ownership in the memory backend

The current `memory()` backend does not clone byte arrays on read or write.
Mutating an array after passing it to `writeFile()`, or mutating an array
returned by `readFile()`, can change the stored file.

Copy when ownership must remain independent:

```js
await filesystem.writeFile("/data.bin", source.slice());

const stored = await filesystem.readFile("/data.bin");
const independent = stored.slice();
```

String writes do not have this issue because they are encoded into a new byte
array.

### Modification times

`mtime` is reported in milliseconds since the Unix epoch. The memory backend
updates it when creating or replacing an entry. Metadata fidelity is not
guaranteed when importing TAR archives or switching backends.

## Sandbox behavior

### Environment replacement

Passing `env` replaces the default environment; it is not merged with it.
Include every variable your commands require:

```js
const sandbox = new Sandbox({
  fs: filesystem,
  engine,
  env: {
    HOME: "/workspace",
    USER: "agent",
    PATH: "/usr/local/bin:/usr/bin:/bin",
    TERM: "xterm-256color",
    SHELL: "/bin/bash",
    LANG: "C.UTF-8",
  },
});
```

When `env` is omitted, nobox supplies those defaults.

### Working directory

Pass an absolute `cwd` to the constructor. The constructor accepts the value as
given, while the `cwd` setter adds a leading slash when needed. Neither verifies
that the directory exists. A later command may fail if its working directory is
unavailable.

`cd` does validate the target and persists the new directory across later
`exec()` calls.

### Exit status

`exec()` returns the status of the last command that ran. The value also
persists as `$?` for later commands on the same sandbox.

An empty script currently leaves the previous status unchanged:

```js
await sandbox.exec("false");
const result = await sandbox.exec("");

console.log(result.code); // 1
```

Non-zero command exits are results, not exceptions. Loading failures and
programming errors may still reject a promise.

### Output buffering

`exec()` buffers complete standard output and standard error before returning.
Pipeline stages are also buffered before the next stage runs. This makes
ordinary scripts predictable but means nobox is not currently suitable for:

- Unbounded streams
- Long-running interactive programs
- Background jobs
- Workloads whose output cannot fit comfortably in memory

Standard error from commands is collected separately from pipeline data.

## Shell quirks

### Variable expansion does not perform Bash word splitting

Variable values remain part of the token in which they appear:

```js
sandbox.env.NAMES = "one two";
await sandbox.exec('printf "%s\\n" "$NAMES"');
```

Do not rely on Bash-compatible field splitting or `IFS` behavior.

### Command substitution collapses whitespace

Captured whitespace is replaced with single spaces and leading or trailing
whitespace is removed:

```sh
echo "files: $(printf 'one\ntwo\n')"
```

Command substitution is limited to eight nested levels.

### Loops are intentionally narrow

The supported form is a single-line `for ... in ...; do ...; done` loop:

```sh
for name in alpha beta gamma; do echo "$name"; done
```

Multiline loop bodies, `while`, `until`, arithmetic loops, functions, and
arrays are unavailable.

### Heredoc expansion depends on the delimiter

Variables are expanded with an unquoted delimiter:

```sh
cat <<EOF > message.txt
hello $USER
EOF
```

Quoting the delimiter keeps the body literal:

```sh
cat <<'EOF' > message.txt
hello $USER
EOF
```

### Redirects and pipelines

Input redirection is applied before a command runs. Output redirection is
supported on the final stage of a pipeline. Avoid relying on redirects attached
to intermediate pipeline stages.

The shell does not currently support comments, globbing, aliases, process
substitution, background execution, or job control.

## Backend switching

`switchBackend(next)` performs a live, non-transactional merge:

1. Files and directories from the active backend are copied into `next`.
2. Existing paths in `next` with the same names are replaced where supported.
3. Unrelated paths already in `next` remain there.
4. `next.flush()` is awaited.
5. The filesystem starts using `next`.
6. The previous backend is closed.

Consequences:

- Prefer a new, empty destination when an exact copy is expected.
- File contents and directory structure migrate; metadata may change.
- If copying or flushing fails, the old backend remains active, but the
  destination may be partially populated.
- If closing the old backend fails, the switch has already occurred even
  though the returned promise rejects.
- Existing sandboxes follow a successful switch because they share the same
  `Filesystem`.

Custom backends should have a root entry available before they are passed to
`switchBackend()`.

## TAR archives

The current TAR support is intended for workspace interchange:

- Export includes regular files and directories.
- Import merges into the destination and overwrites matching files.
- Missing parent directories are created.
- Owners, permissions, links, extended attributes, and exact timestamps are
  not preserved.
- Unsupported TAR entry types are skipped.

Only import trusted archives. The current importer is not a hardened archive
validator and should not be used as a security boundary for hostile input.

## Storage backend contract

File operations in `StorageBackend` are synchronous. Only `flush()` and
`close()` are asynchronous. A backend that uses asynchronous storage should
keep a synchronously accessible working state and perform durability work from
`flush()`.

Expected filesystem failures should use `NoboxError` so both direct filesystem
calls and shell commands receive consistent error codes.
