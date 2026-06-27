// Audio-QR Protocol v2.1 (Bulletproof + Fast)
// Shared encoder/decoder logic for browser + Node
//
// Design goals over v1:
//   - Longer symbols (100 ms) for 2x SNR vs v1's 50 ms
//   - Three independent payload copies + per-byte majority vote
//   - Training tone sequence before payload to learn per-tone gain
//   - Same audible 8-FSK 1200..1900 Hz, same chirp preamble
//
// Frame layout:
//   [CHIRP 500ms 500..2500Hz Hann-enveloped]
//   [200ms gap]
//   [TRAINING 8 symbols 0,1,2,3,4,5,6,7 each 100ms]  ← used for gain calibration
//   [100ms gap]
//   [PAYLOAD COPY 1: framed bytes packed as 8-FSK symbols]
//   [150ms gap, second short chirp 300ms]
//   [PAYLOAD COPY 2]
//   [150ms gap, second short chirp 300ms]
//   [PAYLOAD COPY 3]
//
// Framed bytes per copy: [0xAA 0x55 0xC3] [len] [URL bytes] [CRC16-hi CRC16-lo] [0xC3 0x55 0xAA]

const PROTOCOL = {
  SAMPLE_RATE: 44100,
  SYMBOL_MS: 55,             // tightened for sub-12s broadcasts (still 1.1x v1)
  GUARD_MS: 10,
  PREAMBLE_MS: 500,
  SHORT_PREAMBLE_MS: 300,
  PREAMBLE_LOW: 500,
  PREAMBLE_HIGH: 2500,
  BITS_PER_SYMBOL: 3,
  BASE_FREQ: 1200,
  FREQ_SPACING: 100,
  NUM_TONES: 8,
  TRAINING_SYMBOLS: [0, 1, 2, 3, 4, 5, 6, 7], // one of each tone
  START_MARKER: [0xAA, 0x55, 0xC3],
  END_MARKER: [0xC3, 0x55, 0xAA],
  COPIES: 2,
  POST_PREAMBLE_GAP_MS: 200,
  POST_TRAINING_GAP_MS: 100,
  INTER_COPY_GAP_MS: 150,
  VERSION: "2.1",
};

function symbolFreq(sym) {
  return PROTOCOL.BASE_FREQ + sym * PROTOCOL.FREQ_SPACING;
}

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
  if (bits > 0) syms.push((buf << (3 - bits)) & 0x07);
  return syms;
}

function symbolsToBytes(syms, maxBytes) {
  const bytes = [];
  let buf = 0, bits = 0;
  for (const s of syms) {
    buf = (buf << 3) | (s & 0x07);
    bits += 3;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buf >> bits) & 0xFF);
      if (maxBytes && bytes.length >= maxBytes) break;
    }
  }
  return bytes;
}

function buildFrame(urlBytes) {
  if (urlBytes.length > 200) throw new Error("URL too long (max 200 bytes)");
  const lenByte = urlBytes.length;
  const payload = [lenByte, ...urlBytes];
  const crc = crc16(payload);
  return [
    ...PROTOCOL.START_MARKER,
    ...payload,
    (crc >> 8) & 0xFF, crc & 0xFF,
    ...PROTOCOL.END_MARKER,
  ];
}

// ---------- ENCODE ----------

function makeChirp(sampleRate, durationMs) {
  const n = Math.floor(sampleRate * durationMs / 1000);
  const out = new Float32Array(n);
  const T = durationMs / 1000;
  const f0 = PROTOCOL.PREAMBLE_LOW;
  const f1 = PROTOCOL.PREAMBLE_HIGH;
  const k = (f1 - f0) / T;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const phase = 2 * Math.PI * (f0 * t + 0.5 * k * t * t);
    const env = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);
    out[i] = 0.6 * env * Math.sin(phase);
  }
  return out;
}

function makeSymbolStream(symbols, sampleRate) {
  const symSamples = Math.floor(sampleRate * PROTOCOL.SYMBOL_MS / 1000);
  const guardSamples = Math.floor(sampleRate * PROTOCOL.GUARD_MS / 1000);
  const oneSymTotal = symSamples + guardSamples;
  const out = new Float32Array(symbols.length * oneSymTotal);
  const rampSamples = Math.floor(sampleRate * 0.004);
  for (let s = 0; s < symbols.length; s++) {
    const freq = symbolFreq(symbols[s]);
    const offset = s * oneSymTotal;
    for (let i = 0; i < symSamples; i++) {
      const t = i / sampleRate;
      let env = 1.0;
      if (i < rampSamples) env = i / rampSamples;
      else if (i > symSamples - rampSamples) env = (symSamples - i) / rampSamples;
      out[offset + i] = 0.55 * env * Math.sin(2 * Math.PI * freq * t);
    }
  }
  return out;
}

function encodeBytesToAudio(urlBytes, sampleRate) {
  sampleRate = sampleRate || PROTOCOL.SAMPLE_RATE;
  const frame = buildFrame(urlBytes);
  const symbols = bytesToSymbols(frame);

  const postPreGap = Math.floor(sampleRate * PROTOCOL.POST_PREAMBLE_GAP_MS / 1000);
  const postTrainGap = Math.floor(sampleRate * PROTOCOL.POST_TRAINING_GAP_MS / 1000);
  const interCopyGap = Math.floor(sampleRate * PROTOCOL.INTER_COPY_GAP_MS / 1000);

  const longChirp = makeChirp(sampleRate, PROTOCOL.PREAMBLE_MS);
  const shortChirp = makeChirp(sampleRate, PROTOCOL.SHORT_PREAMBLE_MS);
  const training = makeSymbolStream(PROTOCOL.TRAINING_SYMBOLS, sampleRate);
  const payload = makeSymbolStream(symbols, sampleRate);

  // Layout: [longChirp][postPreGap][training][postTrainGap][payload]
  //         [interCopyGap][shortChirp][postPreGap][training][postTrainGap][payload]
  //         [interCopyGap][shortChirp][postPreGap][training][postTrainGap][payload]
  const oneFirstPass = longChirp.length + postPreGap + training.length + postTrainGap + payload.length;
  const onePass = shortChirp.length + postPreGap + training.length + postTrainGap + payload.length;
  const total = oneFirstPass + (PROTOCOL.COPIES - 1) * (interCopyGap + onePass);
  const out = new Float32Array(total);
  let p = 0;
  // Copy 1 with long chirp
  out.set(longChirp, p); p += longChirp.length;
  p += postPreGap;
  out.set(training, p); p += training.length;
  p += postTrainGap;
  out.set(payload, p); p += payload.length;
  // Copies 2..N with short chirp
  for (let c = 1; c < PROTOCOL.COPIES; c++) {
    p += interCopyGap;
    out.set(shortChirp, p); p += shortChirp.length;
    p += postPreGap;
    out.set(training, p); p += training.length;
    p += postTrainGap;
    out.set(payload, p); p += payload.length;
  }
  return out;
}

function encodeURL(url, sampleRate) {
  const bytes = new TextEncoder().encode(url);
  return encodeBytesToAudio(Array.from(bytes), sampleRate);
}

// ---------- DECODE ----------

function goertzelPower(samples, start, len, freq, sampleRate) {
  const k = Math.round(len * freq / sampleRate);
  const w = 2 * Math.PI * k / len;
  const cosW = Math.cos(w);
  const coeff = 2 * cosW;
  let q1 = 0, q2 = 0;
  for (let i = 0; i < len; i++) {
    const q0 = coeff * q1 - q2 + samples[start + i];
    q2 = q1;
    q1 = q0;
  }
  return q1 * q1 + q2 * q2 - q1 * q2 * coeff;
}

function buildChirpTemplate(sampleRate, durationMs) {
  durationMs = durationMs || PROTOCOL.PREAMBLE_MS;
  const n = Math.floor(sampleRate * durationMs / 1000);
  const tpl = new Float32Array(n);
  const T = durationMs / 1000;
  const f0 = PROTOCOL.PREAMBLE_LOW;
  const f1 = PROTOCOL.PREAMBLE_HIGH;
  const k = (f1 - f0) / T;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    tpl[i] = Math.sin(2 * Math.PI * (f0 * t + 0.5 * k * t * t));
  }
  return tpl;
}

function chirpBandEnergyEnvelope(samples, sampleRate, chirpMs) {
  const hop = Math.max(1, Math.floor(sampleRate * 0.010));
  const winLen = Math.max(64, Math.floor(sampleRate * 0.025));
  const numBlocks = Math.max(0, Math.floor((samples.length - winLen) / hop) + 1);
  const probes = [550, 700, 850, 1000, 2050, 2200, 2350];
  const oobProbes = [200, 300, 3500, 4500, 5500];
  const score = new Float32Array(numBlocks);
  for (let b = 0; b < numBlocks; b++) {
    const start = b * hop;
    let pIn = 0;
    for (const f of probes) pIn += goertzelPower(samples, start, winLen, f, sampleRate);
    let pOob = 0;
    for (const f of oobProbes) pOob += goertzelPower(samples, start, winLen, f, sampleRate);
    score[b] = (pIn / probes.length) - 0.6 * (pOob / oobProbes.length);
  }
  return { score, hop, winLen, numBlocks };
}

function findPreambleCandidates(samples, sampleRate, debugFn, topN, chirpMs) {
  topN = topN || 8;
  chirpMs = chirpMs || PROTOCOL.PREAMBLE_MS;
  const tpl = buildChirpTemplate(sampleRate, chirpMs);
  const tplLen = tpl.length;
  if (samples.length < tplLen + Math.floor(sampleRate * 0.1)) return [];

  let tplEnergy = 0;
  for (let i = 0; i < tplLen; i++) tplEnergy += tpl[i] * tpl[i];
  const tplNorm = Math.sqrt(tplEnergy);

  const env = chirpBandEnergyEnvelope(samples, sampleRate, chirpMs);
  const preBlocks = Math.max(1, Math.round(chirpMs / 10));
  const smoothed = new Float32Array(env.numBlocks);
  let running = 0;
  for (let i = 0; i < env.numBlocks; i++) {
    running += env.score[i];
    if (i >= preBlocks) running -= env.score[i - preBlocks];
    smoothed[i] = i >= preBlocks - 1 ? running : 0;
  }

  const regionCands = [];
  const rMax = Math.max(1, Math.floor(preBlocks / 3));
  for (let i = preBlocks - 1; i < env.numBlocks; i++) {
    if (smoothed[i] <= 0) continue;
    let isMax = true;
    for (let j = Math.max(0, i - rMax); j <= Math.min(env.numBlocks - 1, i + rMax); j++) {
      if (smoothed[j] > smoothed[i]) { isMax = false; break; }
    }
    if (!isMax) continue;
    const blockStart = (i - preBlocks + 1) * env.hop;
    regionCands.push({ pos: Math.max(0, blockStart), score: smoothed[i] });
  }
  regionCands.sort((a, b) => b.score - a.score);
  const regions = regionCands.slice(0, Math.max(topN, 4));
  if (debugFn) debugFn(`Regions: ` + regions.slice(0, 3).map(r => `(${r.pos}:${r.score.toFixed(1)})`).join(" "));

  // Stage 2: cross-correlation refinement
  const refineSpan = Math.floor(sampleRate * 0.080);
  const refineStep = Math.max(1, Math.floor(sampleRate * 0.0005));
  const refined = [];
  for (const r of regions) {
    const lo = Math.max(0, r.pos - refineSpan);
    const hi = Math.min(samples.length - tplLen, r.pos + refineSpan);
    let best = -Infinity, bestPos = r.pos;
    for (let p = lo; p <= hi; p += refineStep) {
      let dot = 0, energy = 0;
      for (let i = 0; i < tplLen; i++) {
        const s = samples[p + i];
        dot += s * tpl[i];
        energy += s * s;
      }
      const norm = energy > 0 ? dot / (Math.sqrt(energy) * tplNorm) : 0;
      if (norm > best) { best = norm; bestPos = p; }
    }
    refined.push({ pos: bestPos, norm: best });
  }
  refined.sort((a, b) => b.norm - a.norm);
  if (debugFn) debugFn(`Refined: ` + refined.slice(0, 3).map(r => `(${r.pos}:${r.norm.toFixed(3)})`).join(" "));
  return refined;
}

// Demodulate one payload region into symbols with per-symbol confidence,
// using training tones to learn per-tone gain compensation.
function demodulate(samples, sampleRate, payloadStart, numSymbols, gains, debugFn) {
  const symSamples = Math.floor(sampleRate * PROTOCOL.SYMBOL_MS / 1000);
  const guardSamples = Math.floor(sampleRate * PROTOCOL.GUARD_MS / 1000);
  const oneSymTotal = symSamples + guardSamples;
  const microRange = Math.floor(sampleRate * 0.006);
  const microStep = Math.max(1, Math.floor(sampleRate * 0.0006));
  let drift = 0;
  const out = [];
  for (let i = 0; i < numSymbols; i++) {
    const c = payloadStart + i * oneSymTotal + drift;
    if (c + symSamples >= samples.length || c < 0) break;
    let bestConf = -1, bestSym = 0, bestOff = 0;
    for (let d = -microRange; d <= microRange; d += microStep) {
      const seg = c + d;
      if (seg < 0 || seg + symSamples >= samples.length) continue;
      let best = 0, second = 0, bs = 0;
      for (let t = 0; t < 8; t++) {
        const f = symbolFreq(t);
        const raw = goertzelPower(samples, seg, symSamples, f, sampleRate);
        const compensated = gains ? raw / Math.max(gains[t], 1e-9) : raw;
        if (compensated > best) { second = best; best = compensated; bs = t; }
        else if (compensated > second) second = compensated;
      }
      if (best <= 0) continue;
      const conf = (best - second) / best;
      if (conf > bestConf) { bestConf = conf; bestSym = bs; bestOff = d; }
    }
    drift += Math.floor(bestOff * 0.3);
    out.push({ sym: bestSym, conf: bestConf });
  }
  return out;
}

// Use training symbols (0..7) to estimate per-tone received power, so we can
// compensate later. Returns an array of 8 gain values, one per tone.
function learnGains(samples, sampleRate, trainingStart) {
  const symSamples = Math.floor(sampleRate * PROTOCOL.SYMBOL_MS / 1000);
  const guardSamples = Math.floor(sampleRate * PROTOCOL.GUARD_MS / 1000);
  const oneSymTotal = symSamples + guardSamples;
  const gains = new Array(8).fill(0);
  for (let i = 0; i < PROTOCOL.TRAINING_SYMBOLS.length; i++) {
    const expectedSym = PROTOCOL.TRAINING_SYMBOLS[i];
    const c = trainingStart + i * oneSymTotal;
    if (c + symSamples >= samples.length) break;
    // Search a small window for the symbol with maximum power at the expected freq
    const microRange = Math.floor(sampleRate * 0.008);
    const microStep = Math.max(1, Math.floor(sampleRate * 0.001));
    let bestP = 0;
    const f = symbolFreq(expectedSym);
    for (let d = -microRange; d <= microRange; d += microStep) {
      const seg = c + d;
      if (seg < 0 || seg + symSamples >= samples.length) continue;
      const p = goertzelPower(samples, seg, symSamples, f, sampleRate);
      if (p > bestP) bestP = p;
    }
    gains[expectedSym] = bestP;
  }
  // Normalize gains so the mean is 1.0 (so compensation is relative)
  let mean = 0; let count = 0;
  for (const g of gains) if (g > 0) { mean += g; count++; }
  if (count === 0) return null;
  mean /= count;
  for (let i = 0; i < 8; i++) gains[i] = gains[i] > 0 ? (gains[i] / mean) : 1.0;
  return gains;
}

function findValidFrame(bytes) {
  const SM = PROTOCOL.START_MARKER;
  const EM = PROTOCOL.END_MARKER;
  for (let i = 0; i + 3 < bytes.length; i++) {
    if (bytes[i] !== SM[0] || bytes[i + 1] !== SM[1] || bytes[i + 2] !== SM[2]) continue;
    const len = bytes[i + 3];
    if (len < 1 || len > 200) continue;
    const payloadEnd = i + 4 + len;
    if (payloadEnd + 4 + 1 > bytes.length) continue;
    const crc = (bytes[payloadEnd] << 8) | bytes[payloadEnd + 1];
    if (bytes[payloadEnd + 2] !== EM[0] || bytes[payloadEnd + 3] !== EM[1] || bytes[payloadEnd + 4] !== EM[2]) continue;
    const payload = [len, ...bytes.slice(i + 4, payloadEnd)];
    if (crc16(payload) !== crc) continue;
    try {
      const url = new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(bytes.slice(i + 4, payloadEnd)));
      return url;
    } catch (e) { return null; }
  }
  return null;
}

// Majority vote across multiple byte streams. For each byte position, pick the
// mode value, breaking ties by lowest index.
function majorityVoteBytes(streams, length) {
  const result = new Array(length);
  for (let i = 0; i < length; i++) {
    const counts = new Map();
    for (const s of streams) {
      const v = s[i];
      if (v === undefined) continue;
      counts.set(v, (counts.get(v) || 0) + 1);
    }
    let bestV = streams[0][i], bestC = -1;
    for (const [v, c] of counts) {
      if (c > bestC) { bestC = c; bestV = v; }
    }
    result[i] = bestV;
  }
  return result;
}

// Best-aligned byte streams: for each stream, find the start marker, slice the
// frame region into uniform length. Returns array of byte arrays each
// approximately the same length.
function alignedStreams(byteStreams) {
  const SM = PROTOCOL.START_MARKER;
  const aligned = [];
  for (const stream of byteStreams) {
    for (let i = 0; i + 4 < stream.length; i++) {
      if (stream[i] === SM[0] && stream[i + 1] === SM[1] && stream[i + 2] === SM[2]) {
        const len = stream[i + 3];
        if (len >= 1 && len <= 200) {
          const sliceLen = Math.min(stream.length - i, 4 + len + 2 + 3);
          aligned.push(stream.slice(i, i + sliceLen));
        }
        break;
      }
    }
  }
  return aligned;
}

function decodeAudio(samples, sampleRate, debugFn) {
  sampleRate = sampleRate || PROTOCOL.SAMPLE_RATE;
  const symSamples = Math.floor(sampleRate * PROTOCOL.SYMBOL_MS / 1000);
  const guardSamples = Math.floor(sampleRate * PROTOCOL.GUARD_MS / 1000);
  const oneSymTotal = symSamples + guardSamples;
  const postPreGap = Math.floor(sampleRate * PROTOCOL.POST_PREAMBLE_GAP_MS / 1000);
  const postTrainGap = Math.floor(sampleRate * PROTOCOL.POST_TRAINING_GAP_MS / 1000);
  const trainingLen = PROTOCOL.TRAINING_SYMBOLS.length * oneSymTotal;
  const longChirpLen = Math.floor(sampleRate * PROTOCOL.PREAMBLE_MS / 1000);
  const shortChirpLen = Math.floor(sampleRate * PROTOCOL.SHORT_PREAMBLE_MS / 1000);

  samples = normalizeSamples(samples);

  // Find all chirps (both long and short). Use long-chirp template; short chirp
  // is detectable too but with slightly lower norm; we collect all candidates.
  const longCands = findPreambleCandidates(samples, sampleRate, debugFn, 10, PROTOCOL.PREAMBLE_MS);
  const shortCands = findPreambleCandidates(samples, sampleRate, debugFn, 10, PROTOCOL.SHORT_PREAMBLE_MS);

  // Dedup candidates that are within 50ms of each other; keep the higher-norm
  const allCands = [...longCands, ...shortCands].filter(c => c.norm > 0.15);
  allCands.sort((a, b) => a.pos - b.pos);
  const dedup = [];
  for (const c of allCands) {
    const last = dedup[dedup.length - 1];
    if (last && Math.abs(c.pos - last.pos) < sampleRate * 0.05) {
      if (c.norm > last.norm) dedup[dedup.length - 1] = c;
    } else {
      dedup.push(c);
    }
  }
  if (debugFn) debugFn(`Chirp candidates after dedup: ${dedup.length}`);

  // For each chirp candidate, try to demodulate a payload after it.
  // Position layout assuming this chirp belongs to a frame:
  //   chirpEnd + postPreGap = trainingStart
  //   trainingStart + trainingLen + postTrainGap = payloadStart
  // We don't know if this was a long or short chirp; try both lengths.
  const byteStreams = [];
  // We need to know expected number of symbols. URL up to 200 bytes -> frame up
  // to 3+1+200+2+3 = 209 bytes -> 209*8/3 = ~557 symbols. We'll demodulate up
  // to MAX_SYMBOLS and find markers within.
  const MAX_SYMBOLS = 600;
  for (const cand of dedup) {
    for (const chirpLen of [longChirpLen, shortChirpLen]) {
      const trainingStart = cand.pos + chirpLen + postPreGap;
      const payloadStart = trainingStart + trainingLen + postTrainGap;
      if (payloadStart + symSamples * 20 >= samples.length) continue;
      const gains = learnGains(samples, sampleRate, trainingStart);
      if (!gains) continue;
      const remaining = samples.length - payloadStart;
      const maxSyms = Math.min(MAX_SYMBOLS, Math.floor(remaining / oneSymTotal));
      const syms = demodulate(samples, sampleRate, payloadStart, maxSyms, gains, debugFn);
      const bytes = symbolsToBytes(syms.map(s => s.sym));
      byteStreams.push(bytes);
      // Try direct decode for this stream
      const url = findValidFrame(bytes);
      if (url) {
        if (debugFn) debugFn(`Direct decode from chirp@${cand.pos} chirpLen=${chirpLen}`);
        return url;
      }
    }
  }
  if (debugFn) debugFn(`No direct decode from ${byteStreams.length} streams; trying majority vote`);

  // Majority vote across aligned streams
  const aligned = alignedStreams(byteStreams);
  if (debugFn) debugFn(`Aligned ${aligned.length} streams for majority vote`);
  if (aligned.length >= 2) {
    const maxLen = Math.max(...aligned.map(a => a.length));
    const minLen = Math.min(...aligned.map(a => a.length));
    if (debugFn) debugFn(`Aligned lengths: min=${minLen} max=${maxLen}`);
    const voted = majorityVoteBytes(aligned, maxLen);
    const url = findValidFrame(voted);
    if (url) {
      if (debugFn) debugFn(`Majority vote decode succeeded`);
      return url;
    }
    // Try every adjacent pair too (sometimes 1 stream is misaligned)
    for (let i = 0; i < aligned.length; i++) {
      for (let j = i + 1; j < aligned.length; j++) {
        const pair = [aligned[i], aligned[j]];
        const len = Math.min(aligned[i].length, aligned[j].length);
        const pairVoted = majorityVoteBytes(pair, len);
        const u = findValidFrame(pairVoted);
        if (u) {
          if (debugFn) debugFn(`Pair-vote decode succeeded streams ${i},${j}`);
          return u;
        }
      }
    }
  }

  if (debugFn) debugFn(`All decode strategies exhausted`);
  return null;
}

function normalizeSamples(samples) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i]);
    if (v > peak) peak = v;
  }
  if (peak < 1e-6) return samples;
  if (peak > 0.6) return samples;
  // Boost so peak ~0.8
  const gain = 0.8 / peak;
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] * gain;
  return out;
}

// ---------- WAV utility ----------

function audioToWav(samples, sampleRate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  let p = 0;
  function ws(s) { for (let i = 0; i < s.length; i++) v.setUint8(p++, s.charCodeAt(i)); }
  function w32(x) { v.setUint32(p, x, true); p += 4; }
  function w16(x) { v.setUint16(p, x, true); p += 2; }
  ws('RIFF'); w32(36 + samples.length * 2); ws('WAVE');
  ws('fmt '); w32(16); w16(1); w16(1); w32(sampleRate); w32(sampleRate * 2); w16(2); w16(16);
  ws('data'); w32(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    let s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(p, s * 32767, true); p += 2;
  }
  return new Uint8Array(buf);
}

// ---- Crockford Base32 token helpers ----
// Alphabet excludes I, L, O, U to avoid ambiguity.
const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function generateToken(length) {
  const n = length || 6;
  let out = "";
  // Prefer crypto.getRandomValues when present (browser + Node 19+).
  let bytes;
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    bytes = new Uint8Array(n);
    crypto.getRandomValues(bytes);
  } else {
    bytes = new Uint8Array(n);
    for (let i = 0; i < n; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  for (let i = 0; i < n; i++) out += CROCKFORD_ALPHABET[bytes[i] & 31];
  return out;
}

function isShortToken(s) {
  if (typeof s !== 'string') return false;
  // Strict Crockford Base32, 6 chars, no I/L/O/U.
  return /^[0-9A-HJKMNP-TV-Z]{6}$/i.test(s);
}

// Normalize a Crockford token for lookup: uppercase + map ambiguous chars.
function normalizeToken(s) {
  if (typeof s !== 'string') return s;
  return s.toUpperCase()
    .replace(/I/g, '1').replace(/L/g, '1')
    .replace(/O/g, '0').replace(/U/g, 'V');
}

const _API = {
  PROTOCOL, encodeURL, encodeBytesToAudio, decodeAudio, audioToWav,
  crc16, buildFrame, bytesToSymbols, symbolsToBytes, findValidFrame,
  generateToken, isShortToken, normalizeToken, CROCKFORD_ALPHABET,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = _API;
} else if (typeof self !== 'undefined') {
  self.AudioQR = _API;
  Object.assign(self, _API);
}
