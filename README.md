# AudioQR

A proof of concept "QR code for sound." Encode a URL into a short audio clip; any phone with a microphone and a web browser can listen to it and recover the URL.

**Live demo:** [https://patwinplastics.github.io/audio-qr/](https://patwinplastics.github.io/audio-qr/)

## What is new in v2.1

- **Short tokens.** A 6-character Crockford Base32 token (about 1.07 billion combinations) can stand in for any URL. The listener fetches `tokens.json` from this site and resolves the token to the full destination URL. A short-token broadcast finishes in roughly **7 to 8 seconds**.
- **Sub-12s full broadcasts.** Symbols tightened from 75 ms to 55 ms with a 10 ms guard. A 14-byte payload (e.g. `apbp.co/PRCH22`) broadcasts in about **10.6 seconds**.
- **Three broadcast modes** in the encoder UI:
  - **Short token** broadcasts only the 6-char token, resolved via the registry on this site
  - **Domain + token** broadcasts a short-domain path you control (e.g. `apbp.co/PRCH22`) for a server-side redirect
  - **Full URL** broadcasts a complete URL with no token at all
- **Token registry.** A static `tokens.json` file on the site maps every token to its destination. New tokens generated in the UI are added to your local registry view; commit the file to persist them publicly.

## How to test

1. **On your computer**, open the live demo and switch to the **Encode** tab. Pick a mode, set the destination URL, optionally roll a new token, then click **Generate audio + register token** and **Play**.
2. **On your phone**, open the same URL and switch to the **Listen** tab. Tap **Start listening**, allow microphone access, and hold your phone near the computer speaker.
3. Within about 8 to 11 seconds the signal decodes and a tap card appears. For short tokens, the page fetches `tokens.json` and shows the resolved URL.

You can also play the encoded WAV through a real FM radio, a podcast, or a TV ad to test the broadcast path.

## How it works (v2.1)

- **Modulation:** 8-FSK in the 1200 to 1900 Hz audible band. Each 55 ms symbol carries 3 bits, with a 10 ms guard between symbols. A 500 ms chirp sweep (500 to 2500 Hz) marks the start of each frame, and the frame is sent twice with its own chirp each time so a listener who starts halfway through still gets a clean catch.
- **Training preamble:** Before every payload copy the encoder sends the eight tones in sequence (0 through 7). The decoder uses these to learn the per-tone gain on the actual microphone and room channel, then compensates the Goertzel powers during payload demod. This is the v2 fix that killed the systematic shared-error pattern that broke v1 on iPhone Safari.
- **Frame format:** `[chirp] [training 0..7] [0xAA 0x55 0xC3] [len] [payload bytes] [CRC-16] [0xC3 0x55 0xAA]`, transmitted twice for redundancy.
- **Error tolerance:** Per-symbol micro-realignment with drift tracking, byte-level majority voting across both copies, and CRC-16 validation. No risky single-copy CRC search that could yield false-positive URLs.
- **Detection:** Two stage. A band energy envelope flags regions of interest using probes placed outside the FSK payload band so payload data does not trick the detector. Then exact cross correlation against a chirp template locks onto sample accurate offset. The heavy work runs in a Web Worker so the UI stays responsive and the Stop button is always live.
- **Why audible band:** FM radio audio is capped at 15 kHz, AM at 5 to 10 kHz, lossy codecs (Opus, MP3 at 128 kbps) preserve the speech band (1 to 4 kHz) best. Putting tones at 1.2 to 1.9 kHz survives FM, AM, podcasts, TV broadcasts, and noisy rooms.
- **Token registry, not lookup server:** The decoded payload is the token itself. The listener performs a static JSON fetch from a public file. No proprietary lookup server, no Chirp/Sonos shortcode patent exposure.

## Crockford Base32 alphabet

`0123456789ABCDEFGHJKMNPQRSTVWXYZ` (32 chars; excludes I, L, O, U to avoid visual ambiguity). Case-insensitive. On the listener side, I, L are remapped to 1, O to 0, and U to V before lookup.

## Patent positioning

This prototype is designed to sit in unencumbered space:

- Uses audible band FSK (DTMF era patents expired)
- Static JSON registry, not a proprietary shortcode lookup service (sidesteps Chirp/Sonos shortcode patent)
- User initiated listening only (sidesteps SilverPush covert listening patents)
- No ultrasonic transmission (sidesteps LISNR portfolio)
- No watermarking of existing media (sidesteps Digimarc and Nielsen)

This is **not legal advice.** Before commercial launch, commission a freedom to operate memo from a patent attorney.

## What this prototype does not include yet

- Cryptographic signing (anti spoofing)
- Reed-Solomon forward error correction (training + majority vote only)
- Analytics, scan tracking, SaaS backend
- iOS or Android native apps
- Server-side token registration API (registry is edited by committing tokens.json)

## File layout

- `index.html` - single page web app (encoder + listener + registry + about)
- `protocol.js` - encode and decode core plus token helpers, usable in browser or Node
- `decoder.worker.js` - Web Worker wrapper around the decoder so the UI never freezes
- `tokens.json` - public short-token registry
- `test.js` - Node side sanity tests (round trip, noise, FM compression)
- `test_realistic.js` - simulates speaker, room, mic at 48 kHz, padded silence, mid signal start
- `test_v21.js` - v2.1 short-token and sub-12s broadcast tests

## Run tests locally

```bash
node test.js
node test_realistic.js
node test_v21.js
```

## License

MIT
