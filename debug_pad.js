const { encodeURL, PROTOCOL } = require("./protocol.js");
const audio = encodeURL("https://americanprobp.com/pages/porch.html");

// Pad with 3s silence
const pad = new Float32Array(44100 * 3);
const out = new Float32Array(pad.length + audio.length + pad.length);
out.set(pad, 0);
out.set(audio, pad.length);
out.set(pad, pad.length + audio.length);

console.log("Padded length:", out.length, "expected chirp start:", pad.length);

// Manually correlate at the known position
function buildChirpTemplate(sr) {
  const preSamples = Math.floor(sr * 500 / 1000);
  const tpl = new Float32Array(preSamples);
  const T = 0.5, f0 = 500, f1 = 2500, k = (f1-f0)/T;
  for (let i = 0; i < preSamples; i++) {
    const t = i / sr;
    tpl[i] = Math.sin(2 * Math.PI * (f0*t + 0.5*k*t*t));
  }
  return tpl;
}

const tpl = buildChirpTemplate(44100);
let tplEn = 0; for (let i = 0; i < tpl.length; i++) tplEn += tpl[i]*tpl[i];
const tplNorm = Math.sqrt(tplEn);

const chirpAt = pad.length;  // 132300
// Sparse correlation at chirp position
let dot = 0, sigEn = 0;
for (let i = 0; i < tpl.length; i += 4) {
  dot += tpl[i] * out[chirpAt + i];
  sigEn += out[chirpAt + i] * out[chirpAt + i];
}
let sparseTplEn = 0;
for (let i = 0; i < tpl.length; i += 4) sparseTplEn += tpl[i]*tpl[i];
const sparseNorm = dot / (Math.sqrt(sparseTplEn) * Math.sqrt(sigEn) + 1e-9);
console.log(`At known chirp position ${chirpAt}: sparse_norm=${sparseNorm.toFixed(4)}`);

// What does the coarse step of 4ms = 176 samples mean?
// Chirp is at 132300. coarse steps: 132300/176 = 751.7
// Nearest steps: 751*176=132176, 752*176=132352
// Offsets from true: -124, +52
// Hann envelope at chirp start ramps from 0 to 1 over 500ms = 22050 samples
// At offset -124 the envelope is already up
// Try those
for (const offTest of [132176, 132352, 132300]) {
  let dot2 = 0, sigEn2 = 0;
  for (let i = 0; i < tpl.length; i += 4) {
    if (offTest + i >= out.length) break;
    dot2 += tpl[i] * out[offTest + i];
    sigEn2 += out[offTest + i] * out[offTest + i];
  }
  const norm2 = dot2 / (Math.sqrt(sparseTplEn) * Math.sqrt(sigEn2) + 1e-9);
  console.log(`  Offset ${offTest}: norm=${norm2.toFixed(4)}, energy=${sigEn2.toFixed(2)}`);
}

// Now actually run findPreambleCandidates and dump the score at the right position
const { decodeAudio } = require("./protocol.js");
console.log("\nRunning full decoder with debug:");
const d = decodeAudio(out, 44100, m => console.log("  DBG:", m));
console.log("Decoded:", d);
