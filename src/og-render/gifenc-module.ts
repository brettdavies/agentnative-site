// Ambient types for the parts of gifenc (https://github.com/mattdesl/gifenc)
// the clip encoder calls; the package ships none. A file with imports cannot
// declare a module that TypeScript has not already seen, so this file stays
// free of imports and exports.

declare module 'gifenc' {
  export type GifPalette = number[][];

  export type GifFrameOptions = {
    palette?: GifPalette;
    /** Milliseconds, stored in the file as hundredths of a second. */
    delay?: number;
    /** -1 plays once, 0 loops forever. */
    repeat?: number;
  };

  export type GifEncoderStream = {
    writeFrame(index: Uint8Array, width: number, height: number, options?: GifFrameOptions): void;
    finish(): void;
    bytes(): Uint8Array;
  };

  export function GIFEncoder(): GifEncoderStream;
  export function quantize(rgba: Uint8Array | Uint8ClampedArray, maxColors: number): GifPalette;
  export function applyPalette(rgba: Uint8Array | Uint8ClampedArray, palette: GifPalette): Uint8Array;
}
