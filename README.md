# AudioQR

A proof of concept "QR code for sound." Encode a URL into a short audio clip; any phone with a microphone and a web browser can listen to it and recover the URL.

**Live demo:** [https://patwinplastics.github.io/audio-qr/](https://patwinplastics.github.io/audio-qr/)

## How to test

1. **On your computer**, open the live demo and switch to the **Encode** tab. The default URL is American Pro's porch page. Click **Generate audio**, then **Play**.
2. **On your phone**, open the same URL and switch to the **Listen** tab. Tap **Start listening**, allow microphone access, and hold your phone near the computer speaker.
3. Within about 27 seconds the signal decodes and a tap card appears with the URL. A live debug log under the mic level shows what the decoder is doing in real time.

You can also play the encoded WAV through a real FM radio, a podcast, or a TV ad to test the broadcast path.

## How it works (v2)

- **Modulation:** 8-FSK in the 1200 to 1900 Hz audible band. Each 75 ms symbol carries 3 bits. A 500 ms chirp sweep (500 to 2500 Hz) marks the start of each frame, and the frame is sent twice with its own chirp each time so a listener who starts halfway through still gets a clean catch.
- **Training preamble:** Before every payload copy the encoder sends the eight tones in sequence (0 through 7). The decoder uses these to learn the per-tone gain on the actual microphone and room channel, then compensates the Goertzel powers during payload demod. This kills the systematic shared-error pattern that broke v1 on iPhone Safari.
- **Frame format:** `[chirp] [training 0..7] [0xAA 0x55 0xC3] [len] [URL bytes] [CRC-16] [0xC3 0x55 0xAA]`, transmitted twice for redundancy.
- **Error tolerance:** Per-symbol micro-realignment with drift tracking, byte-level majority voting across both copies, and CRC-16 validation. No risky single-copy CRC search that could yield false-positive URLs.
- **Detection:** Two stage. First, a band energy envelope flags regions of interest using probes placed outside the FSK payload band so payload data does not trick the detector. Then exact cross correlation against a chirp template locks onto sample accurate offset. The heavy work runs in a Web Worker so the UI stays responsive and the Stop button is always live.
- **Why audible band:** FM radio audio is capped at 15 kHz; AM at 5 to 10 kHz; lossy codecs (Opus, MP3 at 128 kbps) preserve the speech band (1 to 4 kHz) best. Putting tones at 1.2 to 1.9 kHz survives FM, AM, podcasts, TV broadcasts, and noisy rooms.
- **Why direct URL encoding:** Avoids the Chirp/Sonos shortcode to server patent (US 2012/0084131, active until 2032). The URL travels inside the audio; no server lookup is required.

## Patent positioning

This prototype is designed to sit in unencumbered space:

- Uses audible band FSK (DTMF era patents expired)
- Direct URL encoding (sidesteps Chirp/Sonos shortcode patent)
- User initiated listening only (sidesteps SilverPush covert listening patents)
- No ultrasonic transmission (sidesteps LISNR portfolio)
- No watermarking of existing media (sidesteps Digimarc and Nielsen)

This is **not legal advice.** Before commercial launch, commission a freedom to operate memo from a patent attorney.

## What this prototype does not include yet

- Cryptographic signing (anti spoofing)
- Reed-Solomon forward error correction (training + majority vote only)
- Analytics, registry, SaaS backend
- iOS or Android native apps
- Robustness testing across the full codec matrix

## File layout

- `index.html` - single page web app (encoder + listener + about)
- `protocol.js` - encode and decode core, usable in browser or Node
- `decoder.worker.js` - Web Worker wrapper around the decoder so the UI never freezes
- `test.js` - Node side sanity tests (round trip, noise, FM compression)
- `test_realistic.js` - simulates speaker, room, mic at 48 kHz, padded silence, mid signal start

## Run tests locally

```bash
node test.js
node test_realistic.js
```

## License

MIT
