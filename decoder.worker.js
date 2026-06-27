// Decoder Web Worker. Keeps the heavy cross-correlation off the main thread
// so the UI stays responsive and the Stop button works instantly.
importScripts("protocol.js");

self.onmessage = function(e) {
  const msg = e.data;
  if (msg.type !== "decode") return;
  const { samples, sampleRate, jobId } = msg;
  const debug = [];
  const url = AudioQR.decodeAudio(samples, sampleRate, m => {
    if (debug.length < 20) debug.push(m);
  });
  self.postMessage({ type: "result", jobId, url, debug });
};
