# AudioQR

A proof-of-concept "QR code for sound." Encode a URL into a short audio clip; any phone with a microphone and a web browser can listen to it and recover the URL.

**Live demo:** [https://patwinplastics.github.io/audio-qr/](https://patwinplastics.github.io/audio-qr/)

## How to test

1. **On your computer**, open the live demo and switch to the **Encode** tab. The default URL is American Pro's porch page. Click **Generate audio**, then **Play**.
2. **On your phone**, open the same URL and switch to the **Listen** tab. Tap **Start listening**, allow microphone access, and hold your phone near the computer speaker.
3. Wait ~10 seconds. When the signal decodes, a tap card appears with the URL.

You can also play the encoded WAV through a real FM radio, a podcast, or a TV ad to test the broadcast path.

## How it works

- **Modulation:** 8-FSK in the 1200–1900 Hz audible band. Each 50 ms symbol carries 3 bits. A 500 ms chirp sweep (500–2500 Hz) marks the start of each frame.
- **Frame format:** `[chirp preamble] [0xAA 0x55] [len] [URL bytes] [CRC-16] [0x55 0xAA]`, transmitted twice for redundancy.
- **Why audible band:** FM radio audio is capped at 15 kHz; AM at 5–10 kHz; lossy codecs (Opus, MP3 at 128 kbps) preserve the speech band (1–4 kHz) best. Putting tones at 1.2–1.9 kHz survives FM, AM, podcasts, TV broadcasts, and noisy environments.
- **Why direct URL encoding:** Avoids the Chirp/Sonos shortcode-to-server patent (US 2012/0084131, active until 2032). The URL travels inside the audio; no server lookup is required.

## Patent positioning

This v1 prototype is designed to sit in unencumbered space:

- Uses audible-band FSK (DTMF-era patents expired)
- Direct URL encoding (sidesteps Chirp/Sonos shortcode patent)
- User-initiated listening only (sidesteps SilverPush covert-listening patents)
- No ultrasonic transmission (sidesteps LISNR portfolio)
- No watermarking of existing media (sidesteps Digimarc and Nielsen)

This is **not legal advice.** Before commercial launch, commission a freedom-to-operate memo from a patent attorney.

## What this prototype does not include yet

- Cryptographic signing (anti-spoofing)
- Reed-Solomon forward error correction (only CRC-16 right now)
- Analytics / registry / SaaS backend
- iOS or Android native apps
- Robustness testing across the full codec matrix

## File layout

- `index.html` — single-page web app (encoder + listener + about)
- `protocol.js` — encode/decode core, usable in browser or Node
- `test.js` — Node-side sanity tests (round-trip, noise, FM compression)
- `test_output.wav` — sample encoded audio for offline listening

## Run tests locally

```bash
node test.js
```

## License

MIT
