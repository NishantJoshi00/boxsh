//! Embed the boxsh wasm sandbox from a native host via wasmtime.
//!
//! This is the isolation-preserving embedding: the sandbox runs as wasm,
//! exactly the artifact browsers use (engine/fs.wasm), so a buggy command
//! cannot touch the host. The same shape ports to any language with a
//! wasmtime binding (Python `wasmtime`, Go `wasmtime-go`, .NET, Ruby):
//! satisfy the handful of WASI + boxsh_host imports below, then call the
//! `boxsh_*` exports. See docs/embedding.md for the calling convention.
//!
//! Run with: cargo run --release
//! (after: cargo build --release --target wasm32-wasip1 -p boxsh-abi
//!         --features host-commands, from the repo root)

use wasmtime::{Caller, Engine, Instance, Linker, Module, Store};

fn main() -> wasmtime::Result<()> {
    let wasm_path = std::env::args().nth(1).unwrap_or_else(|| {
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../target/wasm32-wasip1/release/boxsh_abi.wasm"
        )
        .to_string()
    });
    let engine = Engine::default();
    let module = Module::from_file(&engine, &wasm_path)?;
    let mut linker: Linker<()> = Linker::new(&engine);

    // WASI: the module needs only this handful (no filesystem — the
    // filesystem IS the module).
    let wasi = "wasi_snapshot_preview1";
    linker.func_wrap(
        wasi,
        "environ_sizes_get",
        |mut c: Caller<'_, ()>, a: i32, b: i32| {
            let mem = memory(&mut c);
            mem.write(&mut c, a as usize, &[0; 4]).unwrap();
            mem.write(&mut c, b as usize, &[0; 4]).unwrap();
            0i32
        },
    )?;
    linker.func_wrap(wasi, "environ_get", |_: Caller<'_, ()>, _: i32, _: i32| {
        0i32
    })?;
    linker.func_wrap(wasi, "sched_yield", || 0i32)?;
    linker.func_wrap(wasi, "proc_exit", |code: i32| -> () {
        std::process::exit(code);
    })?;
    linker.func_wrap(
        wasi,
        "random_get",
        |mut c: Caller<'_, ()>, ptr: i32, len: i32| {
            // Any entropy works for hash seeds; hosts with real needs use getrandom.
            let bytes: Vec<u8> = (0..len)
                .map(|i| (i as u8).wrapping_mul(31).wrapping_add(7))
                .collect();
            memory(&mut c).write(&mut c, ptr as usize, &bytes).unwrap();
            0i32
        },
    )?;
    linker.func_wrap(
        wasi,
        "clock_time_get",
        |mut c: Caller<'_, ()>, _: i32, _: i64, out: i32| {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos() as u64)
                .unwrap_or(0);
            memory(&mut c)
                .write(&mut c, out as usize, &now.to_le_bytes())
                .unwrap();
            0i32
        },
    )?;
    linker.func_wrap(
        wasi,
        "fd_write",
        |mut c: Caller<'_, ()>, _fd: i32, iovs: i32, iovs_len: i32, n: i32| {
            // Panic messages land here; forward to stderr so failures are visible.
            let mem = memory(&mut c);
            let mut total = 0u32;
            for i in 0..iovs_len {
                let mut head = [0u8; 8];
                mem.read(&c, (iovs + i * 8) as usize, &mut head).unwrap();
                let ptr = u32::from_le_bytes(head[..4].try_into().unwrap()) as usize;
                let len = u32::from_le_bytes(head[4..].try_into().unwrap()) as usize;
                let mut buf = vec![0u8; len];
                mem.read(&c, ptr, &mut buf).unwrap();
                eprint!("{}", String::from_utf8_lossy(&buf));
                total += len as u32;
            }
            memory(&mut c)
                .write(&mut c, n as usize, &total.to_le_bytes())
                .unwrap();
            0i32
        },
    )?;

    // boxsh_host: no cold-command engine attached — unknown commands 127.
    // The dirty signal is where a persistence pump would hook in.
    let host = "boxsh_host";
    linker.func_wrap(
        host,
        "host_command_knows",
        |_: Caller<'_, ()>, _: i32, _: i32| 0i32,
    )?;
    linker.func_wrap(
        host,
        "host_command_run",
        |_: Caller<'_, ()>,
         _: i32,
         _: i32,
         _: i32,
         _: i32,
         _: i32,
         _: i32,
         _: i32,
         _: i32,
         _: i32| 127i32,
    )?;
    linker.func_wrap(host, "host_fs_dirty", |_: Caller<'_, ()>, _handle: i32| {})?;

    let mut store: Store<()> = Store::new(&engine, ());
    let instance = linker.instantiate(&mut store, &module)?;
    if let Some(init) = instance.get_func(&mut store, "_initialize") {
        init.typed::<(), ()>(&store)?.call(&mut store, ())?;
    }

    let mut sandbox = Sandbox::new(instance, store)?;
    let (out, err, code) = sandbox.run(
        "export WHO=wasmtime\n\
         echo hello from $WHO > /greeting.txt\n\
         cat /greeting.txt | wc -l\n\
         grep -c wasmtime /greeting.txt",
    )?;
    print!("{out}");
    eprint!("{err}");
    assert_eq!(out, "1\n1\n", "sandbox output mismatch");
    assert_eq!(code, 0, "exit code");
    println!("embedding OK: shell + filesystem + in-module commands, all inside wasm");
    Ok(())
}

fn memory(caller: &mut Caller<'_, ()>) -> wasmtime::Memory {
    caller.get_export("memory").unwrap().into_memory().unwrap()
}

/// Minimal typed wrapper over the boxsh exports — the part each host
/// language reimplements in ~50 lines.
struct Sandbox {
    store: Store<()>,
    instance: Instance,
    fs: i32,
}

impl Sandbox {
    fn new(instance: Instance, mut store: Store<()>) -> wasmtime::Result<Self> {
        let fs = instance
            .get_typed_func::<(), i32>(&mut store, "boxsh_fs_new")?
            .call(&mut store, ())?;
        Ok(Sandbox {
            store,
            instance,
            fs,
        })
    }

    fn alloc(&mut self, bytes: &[u8]) -> wasmtime::Result<i32> {
        let ptr = self
            .instance
            .get_typed_func::<i32, i32>(&mut self.store, "boxsh_alloc")?
            .call(&mut self.store, bytes.len() as i32)?;
        self.memory().write(&mut self.store, ptr as usize, bytes)?;
        Ok(ptr)
    }

    fn memory(&mut self) -> wasmtime::Memory {
        self.instance.get_memory(&mut self.store, "memory").unwrap()
    }

    fn take(&mut self, cell: i32, pair: i32) -> wasmtime::Result<Vec<u8>> {
        let mut words = [0u8; 8];
        self.memory()
            .read(&self.store, (cell + pair * 8) as usize, &mut words)?;
        let ptr = u32::from_le_bytes(words[..4].try_into().unwrap()) as i32;
        let len = u32::from_le_bytes(words[4..].try_into().unwrap()) as i32;
        if len == 0 {
            return Ok(Vec::new());
        }
        let mut data = vec![0u8; len as usize];
        self.memory().read(&self.store, ptr as usize, &mut data)?;
        self.instance
            .get_typed_func::<(i32, i32), ()>(&mut self.store, "boxsh_free")?
            .call(&mut self.store, (ptr, len))?;
        Ok(data)
    }

    /// Run a script with a fresh default session per call (embedders keep
    /// the returned env/cwd to persist sessions; skipped here for brevity).
    fn run(&mut self, script: &str) -> wasmtime::Result<(String, String, i32)> {
        let script_ptr = self.alloc(script.as_bytes())?;
        let cwd_ptr = self.alloc(b"/")?;
        let env = b"\x08\x00\x00\x00USER=box";
        let env_ptr = self.alloc(env)?;
        let cell = self
            .instance
            .get_typed_func::<i32, i32>(&mut self.store, "boxsh_alloc")?
            .call(&mut self.store, 32)?;
        let exec = self
            .instance
            .get_typed_func::<(i32, i32, i32, i32, i32, i32, i32, i32, i32), i32>(
                &mut self.store,
                "boxsh_shell_exec",
            )?;
        let code = exec.call(
            &mut self.store,
            (
                self.fs,
                env_ptr,
                env.len() as i32,
                cwd_ptr,
                1,
                0,
                script_ptr,
                script.len() as i32,
                cell,
            ),
        )?;
        let out = String::from_utf8_lossy(&self.take(cell, 0)?).into_owned();
        let err = String::from_utf8_lossy(&self.take(cell, 1)?).into_owned();
        self.take(cell, 2)?; // env round-trip (unused here)
        self.take(cell, 3)?; // cwd round-trip
        Ok((out, err, code))
    }
}
