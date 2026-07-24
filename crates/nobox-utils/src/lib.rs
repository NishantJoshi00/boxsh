//! nobox-utils: all commands.
//!
//! Native commands are async (D3) and call the VFS directly; ported
//! commands (uutils, D5) enter through the WASI shim; bash (D6) is a
//! command like any other, its parser and evaluator internal modules here.
//! Commands sit behind cargo features for size control (D11).
