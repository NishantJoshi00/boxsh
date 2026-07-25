# Third-party notices

The WebAssembly command modules shipped in this package (`engine/`) contain
compiled code from the following open-source projects. Their license terms
apply to those portions of the binaries.

## uutils coreutils

The bundled commands (`cat`, `ls`, `sort`, `wc`, and others — the `uu_*`
crates, v0.9.x) are compiled from
[uutils coreutils](https://github.com/uutils/coreutils).

MIT License — Copyright (c) uutils developers

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## regex

The bundled modules include the [regex](https://github.com/rust-lang/regex)
crate, dual-licensed under MIT OR Apache-2.0 — Copyright (c) The Rust Project
Developers.

## Other transitive dependencies

The modules additionally contain code from the transitive dependency graphs
of the crates above (all under MIT and/or Apache-2.0 compatible licenses).
A complete machine-generated inventory is available on request via the
contact listed on the npm package page.
