// Plan U5 placeholder; build wiring lands in U8.
//
// SPEC_VERSION reflects `src/data/spec/VERSION`.
// SITE_SPEC_VERSION reflects `content/principles/VERSION`.
// CHECKER_URL is the live-scoring surface — moves with anc.dev.
//
// Hand-edit acceptable until U8 makes this a build-emitted artifact. The
// `.gen.ts` suffix is reserved so when U8 wires `src/build/build.mjs` to
// regenerate this file, the surrounding tooling treats it as generated.

export const SPEC_VERSION = '0.4.0';
export const SITE_SPEC_VERSION = '0.4.0';
export const CHECKER_URL = 'https://anc.dev/score';
