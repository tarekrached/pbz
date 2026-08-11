/*
  _fixture — minimal deterministic pattern used ONLY by the golden-bytes
  characterization test (tools/test/*.test.mjs). Do not push this to the
  device as a "real" pattern; it exists so the compiler output has a fixed,
  known-good bytecode + .pbp snapshot to diff the pre/post-refactor compile
  path against. Keep it small and never edit it casually — any change here
  invalidates the golden snapshot and requires re-capturing it.
*/
export var sliderBrightness = 0.5

export function beforeRender(delta) {
  t1 = time(.1)
}

export function render(index) {
  hsv(t1, 1, sliderBrightness)
}
