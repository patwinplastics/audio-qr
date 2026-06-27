const { encodeURL, decodeAudio, PROTOCOL, audioToWav } = require("./protocol.js");
const fs = require("fs");

function resample(input, srcRate, dstRate) {
  const ratio = dstRate / srcRate;
  const out = new Float32Array(Math.floor(input.length * ratio));
  for (let i = 0; i < out.length; i++) {
    const srcIdx = i / ratio;
    const i0 = Math.floor(srcIdx);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = srcIdx - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}

function simulateRoom(input, sampleRate, opts) {
  opts = opts || {};
  const noiseDb = opts.noiseDb || -30;
  const reverbMs = opts.reverbMs || 30;
  const reverbAtten = opts.reverbAtten || 0.3;
  const gainDb = opts.gainDb || -6;
  const gain = Math.pow(10, gainDb / 20);
  const noiseAmp = Math.pow(10, noiseDb / 20);
  const reverbSamples = Math.floor(sampleRate * reverbMs / 1000);
  const out = new Float32Array(input.length + reverbSamples);
  for (let i = 0; i < input.length; i++) {
    out[i] += input[i] * gain;
    out[i + reverbSamples] += input[i] * gain * reverbAtten;
  }
  let pn = 0;
  for (let i = 0; i < out.length; i++) {
    const n = Math.random() - 0.5;
    pn = 0.96 * pn + 0.04 * n;
    out[i] += pn * noiseAmp * 2;
  }
  return out;
}

const testCases = [
  { name: "Token only (6 char)", url: "ABC123" },
  { name: "Short domain + token", url: "apbp.co/ABC123" },
  { name: "Slightly longer", url: "apbp.co/PORCH1" },
];

for (const tc of testCases) {
  console.log(`\n=== ${tc.name} (${tc.url}, ${tc.url.length} bytes) ===`);
  const audio = encodeURL(tc.url);
  const durSec = audio.length / PROTOCOL.SAMPLE_RATE;
  console.log(`Encoded: ${durSec.toFixed(2)}s`);

  function tryTest(name, transform, captureRate) {
    captureRate = captureRate || PROTOCOL.SAMPLE_RATE;
    const transformed = transform(audio);
    const decoded = decodeAudio(transformed, captureRate);
    const ok = decoded === tc.url;
    console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` (got: ${decoded})`}`);
    return ok;
  }

  tryTest("Clean", x => x);
  tryTest("Phone @ 48 kHz", x => resample(x, 44100, 48000), 48000);
  tryTest("Room -30dB noise", x => simulateRoom(x, 44100, { noiseDb: -30, reverbMs: 30, gainDb: -10 }));
  tryTest("Phone @ 48kHz + room", x => simulateRoom(resample(x, 44100, 48000), 48000, { noiseDb: -25, reverbMs: 40, gainDb: -12 }), 48000);
  tryTest("Noisy -15dB SNR", x => simulateRoom(x, 44100, { noiseDb: -15, reverbMs: 50, gainDb: -10 }));
}
