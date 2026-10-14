// Ambient module for the resvg wasm import. A file with imports cannot
// declare a module that TypeScript has not already seen, so this file
// stays free of imports and exports.

declare module '@resvg/resvg-wasm/index_bg.wasm' {
  const wasmModule: WebAssembly.Module | string;
  export default wasmModule;
}
