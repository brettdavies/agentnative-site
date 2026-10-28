// Ambient modules for the files the render Worker bundles: the resvg wasm,
// the card fonts and the local stand-in clip (Data modules, per the rules in
// ./wrangler.jsonc). A file with imports cannot declare a module that
// TypeScript has not already seen, so this file stays free of imports and
// exports. Under Bun, which runs the tests, each import is the file's path.

declare module '@resvg/resvg-wasm/index_bg.wasm' {
  const wasmModule: WebAssembly.Module | string;
  export default wasmModule;
}

declare module '*.ttf' {
  const data: ArrayBuffer | string;
  export default data;
}

declare module '*.otf' {
  const data: ArrayBuffer | string;
  export default data;
}

declare module '*.mp4' {
  const data: ArrayBuffer | string;
  export default data;
}
