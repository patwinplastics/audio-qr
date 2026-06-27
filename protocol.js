// Audio-QR Protocol v1.2
// Shared encoder/decoder logic for browser + Node
//
// Design:
//   - Audible-band 8-FSK at 1200 to 1900 Hz (8 tones, 100 Hz spacing)
//   - 50 ms symbol + 10 ms guard
//   - 500 ms linear chirp preamble (500 to 2500 Hz)
//   - Two-stage detector: band-energy envelope picks regions of interest,
//     then exact cross-correlation refines to sample-accurate offset.
//   - CRC-16 + 2x payload repetition
//   - URL encoded directly (no server lookup)
//
// Frame: [chirp] [200ms gap] [0xAA 0x55] [len] [URL...] [CRC-16] [0x55 0xAA] twice

const PROTOCOL = {
  SAMPLE_RATE: 44100,
  SYMBOL_MS: 50,
  GUARD_MS: 10,
  PREAMBLE_MS: 500,
  PREAMBLE_LOW: 500,
  PREAMBLE_HIGH: 2500,
  BITS_PER_SYMBOL: 3,
  BASE_FREQ: 1200,
  FREQ_SPACING: 100,
  NUM_TONES: 8,
  START_MARKER: [0xAA, 0x55],
  END_MARKER: [0x55, 0xAA],
  REPEATS: 2,
  POST_PREAMBLE_GAP_MS: 200,
  INTER_REPEAT_GAP_MS: 200,
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

function encodeBytesToAudio(urlBytes, sampleRate) {
  sampleRate = sampleRate || PROTOCOL.SAMPLE_RATE;
  const frame = buildFrame(urlBytes);
  const symbols = bytesToSymbols(frame);

  const preambleSamples = Math.floor(sampleRate * PROTOCOL.PREAMBLE_MS / 1000);
  const symSamples = Math.floor(sampleRate * PROTOCOL.SYMBOL_MS / 1000);
  const guardSamples = Math.floor(sampleRate * PROTOCOL.GUARD_MS / 1000);
  const oneSymTotal = symSamples + guardSamples;
  const postPreGap = Math.floor(sampleRate * PROTOCOL.POST_PREAMBLE_GAP_MS / 1000);
  const interGap = Math.floor(sampleRate * PROTOCOL.INTER_REPEAT_GAP_MS / 1000);

  // Linear chirp preamble with Hann envelope
  const preamble = new Float32Array(preambleSamples);
  const T = PROTOCOL.PREAMBLE_MS / 1000;
  const f0 = PROTOCOL.PREAMBLE_LOW;
  const f1 = PROTOCOL.PREAMBLE_HIGH;
  const k = (f1 - f0) / T;
  for (let i = 0; i < preambleSamples; i++) {
    const t = i / sampleRate;
    const phase = 2 * Math.PI * (f0 * t + 0.5 * k * t * t);
    const env = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / preambleSamples);
    preamble[i] = 0.5 * env * Math.sin(phase);
  }

  const onePayloadLen = symbols.length * oneSymTotal;
  const onePayload = new Float32Array(onePayloadLen);
  const rampSamples = Math.floor(sampleRate * 0.003);
  for (let s = 0; s < symbols.length; s++) {
    const freq = symbolFreq(symbols[s]);
    const offset = s * oneSymTotal;
    for (let i = 0; i < symSamples; i++) {
      const t = i / sampleRate;
      let env = 1.0;
      if (i < rampSamples) env = i / rampSamples;
      else if (i > symSamples - rampSamples) env = (symSamples - i) / rampSamples;
      onePayload[offset + i] = 0.5 * env * Math.sin(2 * Math.PI * freq * t);
    }
  }

  // Each repeat is preceded by its OWN chirp preamble. That way a listener
  // that starts mid-broadcast can still catch the second frame.
  const onePass = preambleSamples + postPreGap + onePayloadLen + interGap;
  const totalLen = onePass * PROTOCOL.REPEATS;
  const out = new Float32Array(totalLen);
  let pos = 0;
  for (let r = 0; r < PROTOCOL.REPEATS; r++) {
    out.set(preamble, pos); pos += preambleSamples;
    pos += postPreGap;
    out.set(onePayload, pos); pos += onePayloadLen;
    pos += interGap;
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

function buildChirpTemplate(sampleRate) {
  const preSamples = Math.floor(sampleRate * PROTOCOL.PREAMBLE_MS / 1000);
  const tpl = new Float32Array(preSamples);
  const T = PROTOCOL.PREAMBLE_MS / 1000;
  const f0 = PROTOCOL.PREAMBLE_LOW;
  const f1 = PROTOCOL.PREAMBLE_HIGH;
  const k = (f1 - f0) / T;
  for (let i = 0; i < preSamples; i++) {
    const t = i / sampleRate;
    tpl[i] = Math.sin(2 * Math.PI * (f0 * t + 0.5 * k * t * t));
  }
  return tpl;
}

// Stage 1: band-energy envelope. For each ~10ms block compute Goertzel power
// at several frequencies that span the chirp sweep band, and subtract an
// estimate of out-of-band power. Smoothing over the chirp duration produces
// a wide plateau wherever a chirp lives in the signal.
function chirpBandEnergyEnvelope(samples, sampleRate) {
  const hop = Math.max(1, Math.floor(sampleRate * 0.010));
  const winLen = Math.max(64, Math.floor(sampleRate * 0.025));
  const numBlocks = Math.max(0, Math.floor((samples.length - winLen) / hop) + 1);
  // Probes are placed OUTSIDE the FSK payload band (1200 to 1900 Hz) so the
  // payload doesn't trigger them. Chirp sweeps the entire 500 to 2500 band
  // so it will light up all of these in turn.
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

function findPreambleCandidates(samples, sampleRate, debugFn, topN) {
  topN = topN || 5;
  const tpl = buildChirpTemplate(sampleRate);
  const tplLen = tpl.length;
  if (samples.length < tplLen + Math.floor(sampleRate * 0.1)) return [];

  let tplEnergy = 0;
  for (let i = 0; i < tplLen; i++) tplEnergy += tpl[i] * tpl[i];
  const tplNorm = Math.sqrt(tplEnergy);

  // Stage 1: band-energy envelope, then smooth over the chirp duration
  const env = chirpBandEnergyEnvelope(samples, sampleRate);
  const preBlocks = Math.max(1, Math.round(PROTOCOL.PREAMBLE_MS / 10));
  const smoothed = new Float32Array(env.numBlocks);
  let running = 0;
  for (let i = 0; i < env.numBlocks; i++) {
    running += env.score[i];
    if (i >= preBlocks) running -= env.score[i - preBlocks];
    smoothed[i] = i >= preBlocks - 1 ? running : 0;
  }

  // Pick local maxima of the smoothed envelope
  const regionCands = [];
  const rMax = Math.max(1, Math.floor(preBlocks / 3));
  for (let i = preBlocks - 1; i < env.numBlocks; i++) {
    if (smoothed[i] <= 0) continue;
    let isMax = true;
    for (let j = Math.max(0, i - rMax); j <= Math.min(env.numBlocks - 1, i + rMax); j++) {
      if (smoothed[j] > smoothed[i]) { isMax = false; break; }
    }
    if (!isMax) continue;
    const approxStart = Math.max(0, (i - preBlocks + 1) * env.hop);
    regionCands.push({ approxStart, score: smoothed[i] });
  }
  regionCands.sort((a, b) => b.score - a.score);

  // Always include offset 0 as a fallback candidate region
  const topRegions = regionCands.slice(0, Math.max(topN, 5));
  if (topRegions.length === 0 || topRegions[0].approxStart > env.hop * 2) {
    topRegions.push({ approxStart: 0, score: 0 });
  }
  if (debugFn) {
    const r = topRegions.slice(0, 3).map(c => `(${c.approxStart}:${(c.score * 1e3).toFixed(1)})`).join(" ");
    debugFn(`Regions: ${r}`);
  }

  // Stage 2: exact cross-correlation refine inside each region.
  // Search a window of +/- one chirp duration. Two-pass: stride-4 dot
  // for coarse, then stride-1 final refine over a few samples.
  const maxStart = samples.length - tplLen - 1;
  const searchHalf = Math.floor(sampleRate * (PROTOCOL.PREAMBLE_MS / 1000));
  const refined = [];
  for (const region of topRegions) {
    const lo = Math.max(0, region.approxStart - searchHalf);
    const hi = Math.min(maxStart, region.approxStart + searchHalf);
    if (hi <= lo) continue;
    let bestS = lo, bestRaw = -Infinity;
    for (let s = lo; s <= hi; s += 1) {
      let dot = 0, sigEn = 0;
      for (let i = 0; i < tplLen; i += 4) {
        const v = samples[s + i];
        dot += tpl[i] * v;
        sigEn += v * v;
      }
      if (sigEn < 1e-6) continue;
      const norm = dot / Math.sqrt(sigEn + 1e-9);
      if (norm > bestRaw) { bestRaw = norm; bestS = s; }
    }
    let exactNorm = -Infinity, exactOffset = bestS;
    const exLo = Math.max(0, bestS - 8);
    const exHi = Math.min(maxStart, bestS + 8);
    for (let s = exLo; s <= exHi; s++) {
      let dot = 0, sigEn = 0;
      for (let i = 0; i < tplLen; i++) {
        const v = samples[s + i];
        dot += tpl[i] * v;
        sigEn += v * v;
      }
      if (sigEn < 1e-6) continue;
      const norm = dot / (tplNorm * Math.sqrt(sigEn) + 1e-9);
      if (norm > exactNorm) { exactNorm = norm; exactOffset = s; }
    }
    refined.push({ offset: exactOffset, norm: exactNorm });
  }
  refined.sort((a, b) => b.norm - a.norm);
  if (debugFn) {
    const top = refined.slice(0, 3).map(c => `(${c.offset}:${c.norm.toFixed(3)})`).join(" ");
    debugFn(`Refined: ${top}`);
  }
  return refined.filter(c => c.norm > 0.15).slice(0, topN);
}

function findPreamble(samples, sampleRate, debugFn) {
  const cands = findPreambleCandidates(samples, sampleRate, debugFn, 1);
  return cands.length > 0 ? cands[0].offset : null;
}

function decodeAudio(samples, sampleRate, debugFn) {
  sampleRate = sampleRate || PROTOCOL.SAMPLE_RATE;
  const symSamples = Math.floor(sampleRate * PROTOCOL.SYMBOL_MS / 1000);
  const guardSamples = Math.floor(sampleRate * PROTOCOL.GUARD_MS / 1000);
  const oneSymTotal = symSamples + guardSamples;
  const preambleSamples = Math.floor(sampleRate * PROTOCOL.PREAMBLE_MS / 1000);
  const postPreGap = Math.floor(sampleRate * PROTOCOL.POST_PREAMBLE_GAP_MS / 1000);

  const candidates = findPreambleCandidates(samples, sampleRate, debugFn, 5);
  if (candidates.length === 0) {
    if (debugFn) debugFn(`No preamble candidates above threshold`);
    return null;
  }

  for (const cand of candidates) {
    const preStart = cand.offset;
    const nominalPayloadStart = preStart + preambleSamples + postPreGap;
    if (debugFn) debugFn(`Trying preamble@${preStart} norm=${cand.norm.toFixed(3)} payload@${nominalPayloadStart}`);
    const align = Math.floor(sampleRate * 0.005);
    const maxAlign = Math.floor(sampleRate * 0.06);
    for (let off = -maxAlign; off <= maxAlign; off += align) {
      const start = nominalPayloadStart + off;
      if (start < 0 || start + oneSymTotal * 20 > samples.length) continue;
      const result = tryDecodeFrom(samples, sampleRate, start, oneSymTotal, symSamples, debugFn, off);
      if (result) return result;
    }
  }
  if (debugFn) debugFn(`All candidates exhausted, no valid frame`);
  return null;
}

function tryDecodeFrom(samples, sampleRate, start, oneSymTotal, symSamples, debugFn, offTag) {
  const maxSyms = Math.min(400, Math.floor((samples.length - start) / oneSymTotal));
  if (maxSyms < 20) return null;
  const syms = new Array(maxSyms);
  for (let s = 0; s < maxSyms; s++) {
    const segStart = start + s * oneSymTotal;
    let bestSym = 0, bestPow = -Infinity;
    for (let t = 0; t < PROTOCOL.NUM_TONES; t++) {
      const f = symbolFreq(t);
      const p = goertzelPower(samples, segStart, symSamples, f, sampleRate);
      if (p > bestPow) { bestPow = p; bestSym = t; }
    }
    syms[s] = bestSym;
  }

  const bytes = symbolsToBytes(syms);

  for (let i = 0; i < bytes.length - 7; i++) {
    if (bytes[i] === 0xAA && bytes[i + 1] === 0x55) {
      const lenByte = bytes[i + 2];
      if (lenByte < 1 || lenByte > 200) continue;
      const payloadEnd = i + 3 + lenByte;
      if (payloadEnd + 4 > bytes.length) continue;
      const payload = bytes.slice(i + 2, payloadEnd);
      const crcRecv = (bytes[payloadEnd] << 8) | bytes[payloadEnd + 1];
      const crcCalc = crc16(payload);
      if (crcRecv === crcCalc) {
        if (bytes[payloadEnd + 2] === 0x55 && bytes[payloadEnd + 3] === 0xAA) {
          const urlBytes = bytes.slice(i + 3, payloadEnd);
          try {
            const url = new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(urlBytes));
            if (debugFn) debugFn(`FRAME OK at align ${offTag}, len=${lenByte}, url="${url}"`);
            return url;
          } catch (e) { /* fall through */ }
        }
      }
    }
  }
  return null;
}

// ---------- WAV ----------

function audioToWav(samples, sampleRate) {
  const numSamples = samples.length;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);
  writeStr(view, 0, "RIFF");
  view.setUint32(4, 36 + numSamples * 2, true);
  writeStr(view, 8, "WAVE");
  writeStr(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(view, 36, "data");
  view.setUint32(40, numSamples * 2, true);
  for (let i = 0; i < numSamples; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, v * 0x7FFF, true);
  }
  return buffer;
}
function writeStr(view, offset, s) {
  for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
}

const _API = { PROTOCOL, encodeURL, encodeBytesToAudio, decodeAudio, audioToWav, crc16, buildFrame, bytesToSymbols, symbolsToBytes };
if (typeof module !== "undefined" && module.exports) module.exports = _API;
if (typeof window !== "undefined") window.AudioQR = _API;
if (typeof self !== "undefined" && typeof window === "undefined") self.AudioQR = _API;
