/**
 * A precompiled WebAssembly module. The standard `WebAssembly.Module`
 * interface has no instance members, so `object` preserves its structural
 * contract without forcing Node consumers to include the DOM type library.
 */
type CompiledWebAssemblyModule = object;

/** A source accepted when loading a WebAssembly engine module. */
export type EngineSource =
  | string
  | URL
  | ArrayBuffer
  | ArrayBufferView
  | CompiledWebAssemblyModule;

/** Explicit command-module sources for `loadEngine`. */
export interface LoadEngineOptions {
  commands: EngineSource;
  /**
   * Accepted for compatibility and ignored. Optimized commands now live
   * inside the sandbox module itself.
   */
  optimizedCommands?: EngineSource;
}
