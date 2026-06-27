// More realistic test: simulate speaker->room->phone mic path
const { encodeURL, decodeAudio, PROTOCOL } = require("./protocol.js");

const url = "https://americanprobp.com/pages/porch.html";
const audio = encodeURL(url);
console.log("Encoded", audio.length, "samples @", PROTOCOL.SAMPLE_RATE, "Hz =", (audio.length/PROTOCOL.SAMPLE_RATE).toFixed(2), "sec");

// Simulate phone mic capturing at 48kHz (most phones)
// Resample 44100 -> 48000 with linear interpolation
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

// Simulate room: short reverb (just early reflections) + background noise + slight gain variation
function simulateRoom(input, sampleRate, opts) {
  opts = opts || {};
  const noiseDb = opts.noiseDb || -30;        // background noise level
  const reverbMs = opts.reverbMs || 30;
  const reverbAtten = opts.reverbAtten || 0.3;
  const gainDb = opts.gainDb || -6;            // mic captures quieter than playback
  const gain = Math.pow(10, gainDb / 20);
  const noiseAmp = Math.pow(10, noiseDb / 20);
  const reverbSamples = Math.floor(sampleRate * reverbMs / 1000);

  const out = new Float32Array(input.length + reverbSamples);
  for (let i = 0; i < input.length; i++) {
    // direct path
    out[i] += input[i] * gain;
    // early reflection
    out[i + reverbSamples] += input[i] * gain * reverbAtten;
  }
  // bg noise (pink-ish)
  let pn = 0;
  for (let i = 0; i < out.length; i++) {
    const n = Math.random() - 0.5;
    pn = 0.96 * pn + 0.04 * n;
    out[i] += pn * noiseAmp * 2;
  }
  return out;
}

function testCase(name, transformFn, captureSampleRate) {
  const transformed = transformFn(audio);
  captureSampleRate = captureSampleRate || PROTOCOL.SAMPLE_RATE;
  const debug = [];
  const decoded = decodeAudio(transformed, captureSampleRate, m => debug.push(m));
  const ok = decoded === url;
  console.log(`\n[${ok ? "PASS" : "FAIL"}] ${name}`);
  console.log("  Decoded:", decoded);
  debug.forEach(d => console.log("  ·", d));
}

// Test 1: clean
testCase("Clean", x => x);

// Test 2: phone at 48 kHz capture
testCase("Phone capture at 48 kHz", x => resample(x, 44100, 48000), 48000);

// Test 3: speaker -> 1m phone mic with moderate room noise
testCase("Speaker → mic @ -30dB noise + 30ms reverb",
  x => simulateRoom(x, 44100, { noiseDb: -30, reverbMs: 30, reverbAtten: 0.3, gainDb: -10 }));

// Test 4: phone capture (48kHz) + room
testCase("Phone @ 48kHz + room",
  x => simulateRoom(resample(x, 44100, 48000), 48000, { noiseDb: -25, reverbMs: 40, reverbAtten: 0.4, gainDb: -12 }),
  48000);

// Test 5: very noisy
testCase("Noisy: -15 dB SNR room",
  x => simulateRoom(x, 44100, { noiseDb: -15, reverbMs: 50, reverbAtten: 0.4, gainDb: -10 }));

// Test 6: padded with 3 sec silence before and after (simulates listening longer than signal)
testCase("With 3s silence padding before/after", x => {
  const pad = new Float32Array(44100 * 3);
  const out = new Float32Array(pad.length + x.length + pad.length);
  out.set(pad, 0);
  out.set(x, pad.length);
  out.set(pad, pad.length + x.length);
  return out;
});

// Test 7: only the second half of the signal (simulating user starting listening late)
testCase("Truncated: start mid-signal", x => x.slice(Math.floor(x.length * 0.4)));
