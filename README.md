# Lilt

**A small acoustic language for sending text between two computers with a
speaker and a microphone.**

No network. No cable. One machine sings a short sequence of pure tones; the
other listens through its microphone, repairs what the room damaged, and turns
the tones back into text.

The app is a dependency-free web page. Open it on both computers, leave one
listening, and send from the other.

## Run it

On **each** computer:

```bash
cd sound
npm start
```

Then open <http://localhost:8787> in a browser on that computer. No install
step is needed; the app and its dev server have no dependencies.

The server listens on both loopback families:

```text
http://localhost:8787
http://127.0.0.1:8787   IPv4 loopback
http://[::1]:8787       IPv6 loopback
```

> **Why localhost on each machine?** Browsers only allow microphone access in a
> secure context. `localhost`, `127.0.0.1`, and `::1` are all treated as secure
> loopback addresses; `http://192.168.x.x` is not. If you host the app somewhere
> else, it needs HTTPS.

Then:

1. On the receiving computer, click **Open microphone** and allow access.
2. On the sending computer, type a message and click **Send by sound**.
3. Turn the speaker up. Keep both computers in the same room, ideally not
   buried under a desk or pointed directly into a wall.
4. Watch the receiving computer. The message appears after the full frame has
   arrived and its checksum agrees.

The **How the language works** dialog in the app has a short tour, and
[`PROTOCOL.md`](PROTOCOL.md) has the full language and frame specification.

## Send and listen from the terminal

The same language is available without a browser. On the receiving computer:

```bash
npm run listen
```

It opens the microphone, prints each decoded message to **standard output**
(one message per line), and sends progress and errors to standard error. Press
Ctrl+C to stop. Use `--mic <index|name>` or `LILT_MIC` to choose an input, and
`--once` to exit after the first message.

On the sending computer:

```bash
npm run send -- "hello from the room"
```

The positional text is the message; `--text` is equivalent. You can also pipe
text into the sender:

```bash
printf 'hello from a pipe' | npm run send
```

Both commands render the same frames as the web app and use the system speaker
and microphone. Terminal listening is macOS-only for now and needs `ffmpeg` on
your `PATH`; sending uses `afplay` on macOS and `ffplay` elsewhere.

## What Lilt sounds like

A message begins with a two-tone **call** (600 Hz + 2100 Hz), then a short
silence, then a fast melody of sixteen possible tones. It is deliberately
audible rather than ultrasonic: laptop speakers reproduce it, and you can hear
the shape of a sentence passing by.

It carries about **59 bits per second** after error correction. That is slow on
purpose. A room is an echoey, rattly channel, and Lilt spends its bandwidth on
being understood.

- UTF-8 text, up to 512 bytes per message
- 16 tones spaced 100 Hz apart, 600–2100 Hz
- 20 syllables per second; one syllable = 4 bits
- RS(15, 11) Reed–Solomon error correction, two bad syllables repaired per
  codeword
- CRC-8 head check and CRC-16 message seal
- Interleaved body blocks so a short cough does not destroy one whole codeword
- Fully client-side: Web Audio, AudioWorklet, `getUserMedia`, no dependencies
- Dev server binds both IPv4 and IPv6 loopback (`127.0.0.1` and `::1`)

## Good to know

- **It is one-way in v1.** There is no automatic acknowledgement or retry. Send
  again if a message does not arrive.
- **It is half-duplex.** Do not transmit while the other side is sending; the
  sounds collide. The app clears its own captured audio after speaking so it
  does not decode itself.
- **It is not private.** Everything is audible in the room. Do not send secrets.
- **It is not Wi-Fi.** Both computers must be within microphone range of each
  other's speakers.
- The microphone is only captured locally. No audio or text leaves the browser.
- Current Chrome, Edge, Firefox, and Safari support the APIs used. AudioWorklet
  is preferred; the app falls back to a ScriptProcessor if necessary.

## Tests

```bash
npm test
```

The test suite covers the GF(16) Reed–Solomon code, CRCs, frame round-trips,
interleaving, checksum rejection, WAV round-trips, and end-to-end acoustic
decoding through noise, echo, sample-rate variation, and long Unicode messages.

There is also a real speaker-to-microphone loopback test, kept out of the
default run because it needs hardware and permission to use it:

```bash
npm run test:acoustic
```

On macOS it renders a packet, plays it with `afplay`, records the room with
`ffmpeg`/`avfoundation`, and asserts that the text comes back. It needs
`ffmpeg` on your `PATH`. It finds the system input automatically, sets the
output volume to 40 for the test (and restores it afterwards), and uses
`--mic`/`LILT_MIC` to choose an input:

```bash
npm run acoustic -- --text "hello, room" --keep
```

The test plays a short melody into the room, so keep the room reasonably quiet.
It is deliberately not part of `npm test`.

## Files

```text
index.html             interface
styles.css             visual design
src/protocol.js        tone alphabet, CRC, RS(15,11), frame layout
src/dsp.js             synthesis, Goertzel demodulation, call detection, decode
src/audio.js           microphone ring buffer and speaker playback
src/app.js             receiving state machine and interface behaviour
src/capture-worklet.js microphone sample pump
src/wav.js             PCM WAV codec for the acoustic test
scripts/serve.js       dual-stack IPv4/IPv6 local dev server
scripts/send.js        play one message through the speaker
scripts/listen.js      print messages heard through the microphone
scripts/live-receiver.js  streaming call/head/body state machine
scripts/audio-tools.js system speaker, microphone and ffmpeg helpers
scripts/acoustic-loopback.js  speaker → microphone hardware test
tests/                 protocol and acoustic simulations
PROTOCOL.md            the language specification
```

## The name

A *lilt* is a rising or falling cadence — a small melody that carries a
sentence. The receiver hears a call, reads the greeting, checks the head, and
only then trusts the body. It is a modem with manners.
