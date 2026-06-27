// Sanity test: encode a URL, decode it back, verify match
const { encodeURL, decodeAudio, PROTOCOL, audioToWav } = require("./protocol.js");
const fs = require("fs");

const url = "https://americanprobp.com/pages/porch.html";
console.log("Encoding URL:", url);
console.log("URL length:", url.length, "bytes");

const audio = encodeURL(url);
console.log("Audio length:", audio.length, "samples =", (audio.length / PROTOCOL.SAMPLE_RATE).toFixed(2), "sec");

// Round-trip decode
console.log("\nDecoding clean audio...");
const decoded = decodeAudio(audio, PROTOCOL.SAMPLE_RATE);
console.log("Decoded:", decoded);
console.log("Match:", decoded === url ? "YES" : "NO");

// Decode with noise added
console.log("\nDecoding with 1% white noise...");
const noisy = new Float32Array(audio.length);
for (let i = 0; i < audio.length; i++) {
  noisy[i] = audio[i] + (Math.random() - 0.5) * 0.02;
}
const decoded2 = decodeAudio(noisy, PROTOCOL.SAMPLE_RATE);
console.log("Decoded:", decoded2);
console.log("Match:", decoded2 === url ? "YES" : "NO");

// Decode with simulated compression (low-pass + clipping)
console.log("\nDecoding with simulated FM compression (lowpass 6kHz + clip)...");
const compressed = new Float32Array(audio.length);
let prev = 0;
const alpha = 0.6;  // crude one-pole lowpass
for (let i = 0; i < audio.length; i++) {
  prev = alpha * prev + (1 - alpha) * audio[i];
  compressed[i] = Math.max(-0.7, Math.min(0.7, prev * 1.5));  // soft clip
}
const decoded3 = decodeAudio(compressed, PROTOCOL.SAMPLE_RATE);
console.log("Decoded:", decoded3);
console.log("Match:", decoded3 === url ? "YES" : "NO");

// Save WAV for manual listening
const wav = audioToWav(audio, PROTOCOL.SAMPLE_RATE);
fs.writeFileSync("/home/user/workspace/audio-qr/test_output.wav", Buffer.from(wav));
console.log("\nWrote test_output.wav (" + (Buffer.from(wav).length / 1024).toFixed(1) + " KB)");
