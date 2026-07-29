import { loadEngine, type EngineSource } from "@boxsh/sandbox";

const compiled: EngineSource = new WebAssembly.Module(new Uint8Array());
void loadEngine({ commands: compiled });
