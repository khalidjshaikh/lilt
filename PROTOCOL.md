# Lilt/1

**An acoustic language for short text.** A speaker pushes pressure into a room;
another computer's microphone reads the pressure back. Lilt is the grammar
between them.

Lilt is deliberately narrow: sixteen tones, one nibble at a time, a little
error correction, and a checksum that refuses to guess.

---

## 1. Design goals

1. Work with ordinary laptop speakers and microphones, in an ordinary room.
2. Be audible but not unbearable.
3. Prefer a correct message over a fast one.
4. Require no network, pairing, or shared clock.
5. Fail honestly: never display a body that has not passed its seal.

The resulting channel is slow — about **59 payload bits per second** — and
surprisingly robust.

---

## 2. The alphabet

A **syllable** is one pure tone lasting 50 ms: 45 ms voiced, 5 ms hush. The
hush is a guard interval against echoes and speaker decay.

Each syllable carries one nibble. The sixteen tones are spaced 100 Hz apart:

| Sound | Hex | Hz   |    | Sound | Hex | Hz   |
| ----- | --- | ---- | -- | ----- | --- | ---- |
| ●     | 0   | 600  |    | ●     | 8   | 1400 |
| ●     | 1   | 700  |    | ●     | 9   | 1500 |
| ●     | 2   | 800  |    | ●     | A   | 1600 |
| ●     | 3   | 900  |    | ●     | B   | 1700 |
| ●     | 4   | 1000 |    | ●     | C   | 1800 |
| ●     | 5   | 1100 |    | ●     | D   | 1900 |
| ●     | 6   | 1200 |    | ●     | E   | 2000 |
| ●     | 7   | 1300 |    | ●     | F   | 2100 |

Two syllables make one byte. A **phrase** is eleven data syllables plus four
parity syllables. A **stanza** is one complete frame.

The transmitter applies a short raised-cosine fade at each end of a tone. This
keeps the speaker from clicking and keeps the spectrum tidy.

---

## 3. Grammar of a stanza

```text
  hush     CALL       hush       GREETING        HEAD           BODY …
 ───────  ─────────  ────────  ─────────────  ─────────────  ───────────────
 silence  600+2100    100 ms   8 syllables    15 syllables   15 × N syllables
          600 ms               400 ms         750 ms         750 × N ms

                                       BODY: data phrases, interleaved
                                       └─ last two bytes are the seal
```

### 3.1 Call

A 600 ms chord of **600 Hz and 2100 Hz**, followed by 100 ms of silence.

The call is an attention signal, not data. Its two widely separated tones are
easy to distinguish from speech and from the single-tone data syllables. The
receiver looks for both frequencies holding energy together for at least
300 ms.

### 3.2 Greeting

Eight known syllables:

```text
F 0 5 A 3 C 9 6
```

The greeting is the clock. Once the receiver has found the call, it searches
around the expected boundary for the alignment that maximizes the energy in
this exact sequence. The search is coarse at 4 ms steps, then refined to 1 ms.

The greeting also gives the demodulator a fresh estimate of the room's timing.
No shared clock is needed; the two computers may run at 44.1 kHz or 48 kHz
independently.

### 3.3 Head

The head is fifteen syllables: eleven data syllables followed by four parity
syllables.

Its eleven data syllables carry five bytes:

| Byte | Meaning |
| ---- | ------- |
| 0 | high nibble: protocol version (`1`); low nibble: flags (`0` for text) |
| 1 | message id (0–255, chosen by the sender) |
| 2 | payload length, high byte |
| 3 | payload length, low byte |
| 4 | CRC-8 of bytes 0–3 |

The tenth nibble is a zero pad. The eleven nibbles are encoded with RS(15, 11),
so the head can lose any two syllables and still be read.

The head is deliberately small: it tells the receiver how many body syllables
to expect, and it carries the message id used to recognize a repeat.

### 3.4 Body

The body is the UTF-8 payload followed by a two-byte CRC-16 seal:

```text
payload bytes … | CRC-16 high | CRC-16 low | zero padding to 11 nibbles
```

The padded bytes are split into 11-nibble groups. Each group becomes a
15-syllable RS(15, 11) codeword. The codewords are then **interleaved** before
transmission:

```text
transmit: block0[0] block1[0] … blockN[0]
          block0[1] block1[1] … blockN[1]
          …
          block0[14] block1[14] … blockN[14]
```

A cough that wipes out three consecutive syllables therefore damages three
different codewords, each of which can repair one error, instead of destroying
one codeword with three errors.

The receiver trims the padding using the length in the head, recomputes the
CRC-16 over `head[0..4] + payload`, and compares it with the seal.

### 3.5 Hush

The protocol frame ends after the last body codeword. The app adds a short
silent tail before the next message; no special end symbol is required because
the body length is known.

The app also adds 250 ms of lead-in silence so the first call is not clipped by
the audio device.

---

## 4. Error correction

Lilt uses a systematic **RS(15, 11)** Reed–Solomon code over **GF(16)**.

- Field: GF(2⁴), primitive polynomial `x⁴ + x + 1`
- Primitive element: α = 2
- Generator polynomial: `(x − α¹)(x − α²)(x − α³)(x − α⁴)`
- Codeword: 11 data symbols followed by 4 parity symbols
- Minimum distance: 5
- Correction radius: 2 symbols per codeword

With four parity symbols, any two wrong syllables in a codeword can be located
and repaired. Three or more errors cause the codeword to be rejected rather
than silently accepted; the CRC then catches any improbable miscorrection.

### Checksums

- **CRC-8**, polynomial `0x07`, initial value `0`, over the first four head bytes.
- **CRC-16/CCITT-FALSE**, polynomial `0x1021`, initial value `0xFFFF`, no final
  XOR, over the five head bytes and the payload.

The CRC is the final authority. The message is shown only when the Reed–Solomon
blocks decode and the CRC matches.

---

## 5. Receiving, in order

1. **Listen.** Keep a rolling buffer of microphone audio. Do not transmit while
   listening; Lilt is half-duplex.
2. **Hear a call.** Slide a 30 ms Hann window over the recent audio and look for
   simultaneous energy at 600 Hz and 2100 Hz. Require a sustained run.
3. **Find the greeting.** Search ±180 ms around the expected boundary for the
   eight-syllable greeting, coarse-to-fine.
4. **Read the head.** Demodulate fifteen syllables with 40 ms Hann-windowed
   Goertzel filters at the sixteen tone frequencies. Correct the RS codeword,
   check the head CRC, and learn the body length.
5. **Wait for the body.** If the last body syllable has not arrived, wait. The
   receiver knows exactly how many syllables to expect.
6. **Deinterleave and correct.** Repair each RS codeword, flatten the nibbles,
   trim, and verify the CRC-16.
7. **Show the text.** Deduplicate by `(message id, text)` for a short window in
   case the same frame is heard twice.

The app pauses receiving while its own speaker is active and clears its input
buffer afterwards, so it does not try to read its own voice.

---

## 6. Rates and limits

| Property | Value |
| -------- | ----- |
| Tone count | 16 (4 bits per syllable) |
| Symbol rate | 20 syllables/s |
| Raw rate | 80 bit/s |
| Payload rate after RS | 58.67 bit/s |
| Frame overhead before body | 1.85 s |
| Maximum payload in the app | 512 bytes UTF-8 |
| Body codeword | 15 syllables (0.75 s), 11 nibbles (5.5 bytes) of data |

A short message takes a few seconds:

```text
"hello, world" (12 bytes)  ≈ 4.1 s of air
30-byte sentence           ≈ 6.4 s of air
512-byte message           ≈ 72 s of air
```

These figures count the call, greeting, head, and body; the app adds a small
lead-in and tail.

---

## 7. Failure is a feature

A room is allowed to win. If a chair scrapes across too many syllables, the
receiver says **“I heard the melody, but the words were too broken”** and shows
nothing. It does not fall back to a best guess.

Version 1 has no acknowledgement and no automatic retry. It is a one-way
language: call, greeting, head, body, seal. A reply is another stanza.

---

## 8. Security and privacy

Lilt is audible. Anyone with a microphone can hear a stanza, and the encoding
is not encryption. Do not use it for secrets. The app does not send audio or
text over a network; all processing is local, but the room is the broadcast
medium.

---

## 9. Why the name

A **lilt** is a cadence — a rising or falling turn in a sentence. Lilt is not a
file-transfer protocol wearing a costume. It is a small spoken form: a call to
attention, a greeting, a head that says how much is coming, a body, and a seal.
It is meant to be heard.
