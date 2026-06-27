// Audio-QR Protocol v1
// Shared encoder/decoder logic for browser + Node
//
// Design choices (chosen for FM/AM/podcast survivability + patent avoidance):
//   - Audible-band 8-FSK at 1200–2100 Hz (12 tones, 100 Hz spacing)
//   - Each symbol carries 3 bits, lasts 100 ms with 20 ms guard
//   - 1 sec chirp preamble (500 -> 2500 Hz sweep) for sync detection
//   - URL encoded directly (no server shortcode lookup -> avoids Chirp/Sonos US2012/0084131)
//   - CRC-16 checksum + 3x redundancy (transmit payload three times back-to-back)
//   - Total payload duration for ~25-byte URL: ~7 sec
//
// Payload format on the wire:
//   [1.0s chirp preamble] [start marker 0xAA 0x55] [len byte] [payload bytes] [CRC-16] [end marker 0x55 0xAA]
//   Repeated 3x for redundancy.

const PROTOCOL = {
  SAMPLE_RATE: 44100,
  SYMBOL_MS: 50,           // 50 ms per symbol
  GUARD_MS: 10,            // 10 ms gap between symbols (kills reverb/multipath)
  PREAMBLE_MS: 500,        // 500 ms chirp sweep
  PREAMBLE_LOW: 500,       // sweep start Hz
  PREAMBLE_HIGH: 2500,     // sweep end Hz
  BITS_PER_SYMBOL: 3,      // 8-FSK
  BASE_FREQ: 1200,         // lowest tone Hz
  FREQ_SPACING: 100,       // Hz between adjacent tones
  NUM_TONES: 8,            // 2^BITS_PER_SYMBOL
  START_MARKER: [0xAA, 0x55],
  END_MARKER: [0x55, 0xAA],
  REPEATS: 2,              // payload transmitted 2x (CRC catches errors, 2nd pass is fallback if 1st corrupted)
};

// --- Frequency for symbol value 0..7 ---
function symbolFreq(sym) {
  return PROTOCOL.BASE_FREQ + sym * PROTOCOL.FREQ_SPACING;
}

// --- CRC-16/CCITT ---
function crc16(bytes) {
  let crc = 0xFFFF;
  for (const b of bytes) {
    crc ^= (b << 8);
    for (let i = 0; i < 8; i++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
      crc &= 0xFFFF;
    }
  }
  return crc;
}

// --- bytes -> array of 3-bit symbols (MSB first) ---
function bytesToSymbols(bytes) {
  const syms = [];
  let buf = 0, bits = 0;
  for (const b of bytes) {
    buf = (buf << 8) | b;
    bits += 8;
    while (bits >= 3) {
      bits -= 3;
      syms.push((buf >> bits) & 0x07);
    }
  }
  if (bits > 0) {
    syms.push((buf << (3 - bits)) & 0x07);
  }
  return syms;
}

// --- symbols -> bytes ---
function symbolsToBytes(syms, numBytes) {
  const bytes = [];
  let buf = 0, bits = 0;
  for (const s of syms) {
    buf = (buf << 3) | (s & 0x07);
    bits += 3;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buf >> bits) & 0xFF);
      if (bytes.length >= numBytes) break;
    }
  }
  return bytes;
}

// --- Build the byte frame (no preamble) ---
function buildFrame(urlBytes) {
  if (urlBytes.length > 200) throw new Error("URL too long (max 200 bytes)");
  const lenByte = urlBytes.length;
  const payload = [lenByte, ...urlBytes];
  const crc = crc16(payload);
  const frame = [
    ...PROTOCOL.START_MARKER,
    ...payload,
    (crc >> 8) & 0xFF, crc & 0xFF,
    ...PROTOCOL.END_MARKER,
  ];
  return frame;
}

// --- Encode bytes -> Float32Array audio ---
function encodeBytesToAudio(urlBytes) {
  const sr = PROTOCOL.SAMPLE_RATE;
  const frame = buildFrame(urlBytes);
  const symbols = bytesToSymbols(frame);

  // Preamble: linear chirp sweep
  const preambleSamples = Math.floor(sr * PROTOCOL.PREAMBLE_MS / 1000);
  const preamble = new Float32Array(preambleSamples);
  for (let i = 0; i < preambleSamples; i++) {
    const t = i / sr;
    const T = PROTOCOL.PREAMBLE_MS / 1000;
    const f0 = PROTOCOL.PREAMBLE_LOW;
    const f1 = PROTOCOL.PREAMBLE_HIGH;
    const k = (f1 - f0) / T;
    const phase = 2 * Math.PI * (f0 * t + 0.5 * k * t * t);
    // Hann envelope ramps to avoid clicks
    const env = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / preambleSamples);
    preamble[i] = 0.5 * env * Math.sin(phase);
  }

  // Symbols: 100 ms tone + 20 ms guard, with edge ramps
  const symSamples = Math.floor(sr * PROTOCOL.SYMBOL_MS / 1000);
  const guardSamples = Math.floor(sr * PROTOCOL.GUARD_MS / 1000);
  const oneSymTotal = symSamples + guardSamples;

  // Build one full payload (used REPEATS times)
  const onePayloadSamples = symbols.length * oneSymTotal;
  const onePayload = new Float32Array(onePayloadSamples);
  for (let s = 0; s < symbols.length; s++) {
    const freq = symbolFreq(symbols[s]);
    const offset = s * oneSymTotal;
    for (let i = 0; i < symSamples; i++) {
      const t = i / sr;
      // 5 ms ramp in/out
      const rampSamples = Math.floor(sr * 0.005);
      let env = 1.0;
      if (i < rampSamples) env = i / rampSamples;
      else if (i > symSamples - rampSamples) env = (symSamples - i) / rampSamples;
      onePayload[offset + i] = 0.5 * env * Math.sin(2 * Math.PI * freq * t);
    }
    // guard interval: silence
  }

  // Concatenate: preamble + (silence 200ms) + payload * REPEATS
  const gapBetween = Math.floor(sr * 0.2);
  const totalLen = preambleSamples + gapBetween + (onePayloadSamples + gapBetween) * PROTOCOL.REPEATS;
  const out = new Float32Array(totalLen);
  let pos = 0;
  out.set(preamble, pos); pos += preambleSamples;
  pos += gapBetween;
  for (let r = 0; r < PROTOCOL.REPEATS; r++) {
    out.set(onePayload, pos); pos += onePayloadSamples;
    pos += gapBetween;
  }
  return out;
}

// --- Encode URL (string) -> audio ---
function encodeURL(url) {
  const bytes = new TextEncoder().encode(url);
  return encodeBytesToAudio(Array.from(bytes));
}

// --- Goertzel algorithm for single-tone power detection ---
function goertzelPower(samples, start, len, freq, sampleRate) {
  const k = Math.round(len * freq / sampleRate);
  const w = 2 * Math.PI * k / len;
  const cosW = Math.cos(w);
  const coeff = 2 * cosW;
  let q0, q1 = 0, q2 = 0;
  for (let i = 0; i < len; i++) {
    q0 = coeff * q1 - q2 + samples[start + i];
    q2 = q1;
    q1 = q0;
  }
  return q1 * q1 + q2 * q2 - q1 * q2 * coeff;
}

// --- Decode audio Float32Array -> URL string (or null if not found) ---
function decodeAudio(samples, sampleRate) {
  sampleRate = sampleRate || PROTOCOL.SAMPLE_RATE;
  // Resample-aware symbol size
  const symSamples = Math.floor(sampleRate * PROTOCOL.SYMBOL_MS / 1000);
  const guardSamples = Math.floor(sampleRate * PROTOCOL.GUARD_MS / 1000);
  const oneSymTotal = symSamples + guardSamples;
  const preambleSamples = Math.floor(sampleRate * PROTOCOL.PREAMBLE_MS / 1000);

  // 1. Locate preamble via matched-filter-ish energy scan
  // Search for a contiguous 1-sec region with strong energy across the chirp band
  // Cheap heuristic: scan with 50 ms hop, find peak rising-energy region in 500-2500 Hz
  const hopSamples = Math.floor(sampleRate * 0.05);
  const winSamples = Math.floor(sampleRate * 0.2);

  // Build a simple chirp template and cross-correlate
  // For tractability, we instead detect: strong energy at low end of preamble window, growing
  // We'll just locate where decoding succeeds by trying multiple start offsets.
  const candidateStarts = [];
  for (let s = 0; s + preambleSamples + oneSymTotal * 80 < samples.length; s += hopSamples) {
    // Crude preamble score: energy ratio in 500-2500 Hz band across the window
    let energy = 0;
    for (let i = 0; i < preambleSamples; i++) {
      const v = samples[s + i] || 0;
      energy += v * v;
    }
    if (energy > 0.001 * preambleSamples) {
      candidateStarts.push({ start: s, energy });
    }
  }
  // Sort by energy desc, try top candidates
  candidateStarts.sort((a, b) => b.energy - a.energy);
  const tryStarts = candidateStarts.slice(0, 20).map(c => c.start);

  // Always try the brute-force scan too, in steps of 25 ms
  for (let s = 0; s + preambleSamples + oneSymTotal * 80 < samples.length; s += Math.floor(sampleRate * 0.025)) {
    tryStarts.push(s);
  }

  for (const preStart of tryStarts) {
    // Payload starts after preamble + 200 ms gap
    const payloadStart = preStart + preambleSamples + Math.floor(sampleRate * 0.2);
    // Try fine alignment within ± 60 ms
    for (let align = -Math.floor(sampleRate * 0.06); align <= Math.floor(sampleRate * 0.06); align += Math.floor(sampleRate * 0.01)) {
      const result = tryDecodeFrom(samples, sampleRate, payloadStart + align, oneSymTotal, symSamples);
      if (result) return result;
    }
  }
  return null;
}

function tryDecodeFrom(samples, sampleRate, start, oneSymTotal, symSamples) {
  // Decode up to 250 symbols and search for start marker
  const maxSyms = Math.min(250, Math.floor((samples.length - start) / oneSymTotal));
  if (maxSyms < 20) return null;
  const syms = [];
  for (let s = 0; s < maxSyms; s++) {
    const segStart = start + s * oneSymTotal;
    if (segStart + symSamples > samples.length) break;
    // Find tone with max Goertzel power
    let bestSym = 0, bestPow = -1;
    for (let t = 0; t < PROTOCOL.NUM_TONES; t++) {
      const f = symbolFreq(t);
      const p = goertzelPower(samples, segStart, symSamples, f, sampleRate);
      if (p > bestPow) { bestPow = p; bestSym = t; }
    }
    syms.push(bestSym);
  }

  // Convert symbols to bytes
  const bytes = symbolsToBytes(syms, Math.floor(syms.length * 3 / 8));

  // Search for start marker 0xAA 0x55
  for (let i = 0; i < bytes.length - 6; i++) {
    if (bytes[i] === 0xAA && bytes[i + 1] === 0x55) {
      const lenByte = bytes[i + 2];
      if (lenByte < 1 || lenByte > 200) continue;
      const payloadEnd = i + 3 + lenByte;
      if (payloadEnd + 4 > bytes.length) continue;
      const payload = bytes.slice(i + 2, payloadEnd); // includes len
      const crcHi = bytes[payloadEnd];
      const crcLo = bytes[payloadEnd + 1];
      const crcRecv = (crcHi << 8) | crcLo;
      const crcCalc = crc16(payload);
      if (crcRecv === crcCalc) {
        // Validate end marker
        if (bytes[payloadEnd + 2] === 0x55 && bytes[payloadEnd + 3] === 0xAA) {
          // Decode URL
          const urlBytes = bytes.slice(i + 3, payloadEnd);
          try {
            const url = new TextDecoder().decode(new Uint8Array(urlBytes));
            return url;
          } catch (e) { /* fallthrough */ }
        }
      }
    }
  }
  return null;
}

// --- WAV file generation ---
function audioToWav(samples, sampleRate) {
  const numSamples = samples.length;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);
  // RIFF header
  writeStr(view, 0, "RIFF");
  view.setUint32(4, 36 + numSamples * 2, true);
  writeStr(view, 8, "WAVE");
  writeStr(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);   // PCM
  view.setUint16(22, 1, true);   // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(view, 36, "data");
  view.setUint32(40, numSamples * 2, true);
  // PCM samples
  for (let i = 0; i < numSamples; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, v * 0x7FFF, true);
  }
  return buffer;
}
function writeStr(view, offset, s) {
  for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
}

// Export for both Node and browser
if (typeof module !== "undefined" && module.exports) {
  module.exports = { PROTOCOL, encodeURL, encodeBytesToAudio, decodeAudio, audioToWav, crc16, buildFrame, bytesToSymbols, symbolsToBytes };
}
if (typeof window !== "undefined") {
  window.AudioQR = { PROTOCOL, encodeURL, encodeBytesToAudio, decodeAudio, audioToWav, crc16 };
}
