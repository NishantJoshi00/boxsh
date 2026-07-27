//! Native boxsh-fs benchmarks: the upper bound for every host, since no
//! wasm boundary or host storage is involved. Run with `cargo run --release`.
//!
//! The same ops cross the ABI in the browser/node benches; comparing those
//! numbers against these isolates the boundary cost from the filesystem
//! cost.

use std::hint::black_box;
use std::time::Instant;

use boxsh_fs::{Backend, MemoryBackend, tar};

fn bench(name: &str, iters: u32, mut f: impl FnMut(u32)) {
    for i in 0..iters.min(50) {
        f(i); // warmup
    }
    let start = Instant::now();
    for i in 0..iters {
        f(i);
    }
    let elapsed = start.elapsed();
    let us_per_op = elapsed.as_secs_f64() * 1e6 / f64::from(iters);
    let per_sec = 1e6 / us_per_op;
    println!("{name:<34} {us_per_op:>10.3} µs/op {per_sec:>14.0} ops/s");
}

fn seeded(files: u32) -> MemoryBackend {
    let mut b = MemoryBackend::new();
    b.set_time(1_700_000_000_000);
    b.mkdir("bench").unwrap();
    let data = vec![0x61u8; 1024];
    for i in 0..files {
        b.write(&format!("bench/w{i}.txt"), &data).unwrap();
    }
    b.take_dirty();
    b
}

fn main() {
    println!("boxsh-fs native bench (MemoryBackend, no boundary)\n");
    let one_k = vec![0x61u8; 1024];
    let sixty_four_k = vec![0x62u8; 65536];

    let mut b = seeded(512);
    bench("write 1KiB (512 paths)", 200_000, |i| {
        b.write(&format!("bench/w{}.txt", i % 512), &one_k).unwrap();
    });
    bench("write 64KiB (64 paths)", 20_000, |i| {
        b.write(&format!("bench/big{}", i % 64), &sixty_four_k).unwrap();
    });
    bench("read 1KiB", 200_000, |i| {
        black_box(b.read(&format!("bench/w{}.txt", i % 512)).unwrap());
    });
    bench("entry", 500_000, |i| {
        black_box(b.entry(&format!("bench/w{}.txt", i % 512)).unwrap());
    });
    bench("list (512 children)", 10_000, |_| {
        black_box(b.list("bench").unwrap());
    });

    // Rename a small subtree back and forth.
    let mut b = MemoryBackend::new();
    b.mkdir("tree").unwrap();
    for i in 0..100 {
        b.write(&format!("tree/f{i}"), &one_k).unwrap();
    }
    b.take_dirty();
    bench("rename subtree (100 nodes)", 10_000, |i| {
        let (from, to) = if i % 2 == 0 { ("tree", "moved") } else { ("moved", "tree") };
        b.rename(from, to).unwrap();
    });

    // Journal: the cost persistence hosts pay per drain, minus storage.
    let mut b = seeded(512);
    bench("journal drain (512 writes)", 2_000, |_| {
        for i in 0..512u32 {
            b.write(&format!("bench/w{i}.txt"), &one_k).unwrap();
        }
        black_box(b.take_dirty());
    });

    // Tar: the universal export/import path.
    let mut src = seeded(1000);
    bench("tar export (1000×1KiB)", 500, |_| {
        black_box(tar::export(&mut src).unwrap());
    });
    let archive = tar::export(&mut src).unwrap();
    bench("tar import (1000×1KiB)", 200, |_| {
        let mut dst = MemoryBackend::new();
        tar::import(&mut dst, &archive).unwrap();
        black_box(&dst);
    });
}
