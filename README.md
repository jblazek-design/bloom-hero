# Bloom: hand-tracked hero

## Run it
The camera only works over `http://localhost` (or HTTPS), not when you double-click index.html.

- **Mac:** double-click `start.command` (first time: right-click → Open). It opens http://localhost:5173.
- **Or in Terminal:** `cd` into this folder, run `python3 -m http.server 5173`, then open http://localhost:5173.
- Allow camera access when the browser asks.

## Controls
| Gesture | What happens |
|---|---|
| Fist → open hand (slowly) | Video 1 scrubs frame by frame: buds → full bloom. Each word of the text blooms in with it. |
| **Clap / bring both open palms together** | The flowers finish opening and Video 2 plays (bloom → burn). The text changes to "nvm ;)". |
| Clap again | Video 3 plays (burn → bloom), the original text comes back, and your hand controls the flowers again. |
| Snap (backup) | Same as a clap. As soon as the snap pose shows (thumb on middle finger, index still out), the flowers freeze, so they don't close while you snap. |

The black box shows the live camera (mirrored) with the hand skeleton on top.
Keys: **Space** or a **click** = trigger · **M** = mouse mode (move left↔right to open) · **C** = camera feed on/off · **D** = live values for tuning.

## Tuning
All thresholds are at the top of `app.js` (`CFG`):
- `openLo` / `openHi`: hand openness range (press D to see your live `ratio`; fist ≈ 0.8–1.1, open hand ≈ 1.8–2.0). The range also adjusts itself slightly as you use it.
- `follow`: how quickly the video follows your hand.
- `clapHit` / `clapArm`: how close the palms must get (and how far apart they start) for a clap.
- `snapPinch`, `snapIndex`, `snapHold`, `snapDrop`, `snapWindow`: snap sensitivity and freeze.
- `burnTextIn`, `restoreTextOut`, `restoreTextIn`: when the text changes during videos 2 and 3.

## Font
The page uses **PP Editorial Old** when it's installed on your machine. To make it work everywhere, put `PPEditorialOld-Regular.woff2` and `PPEditorialOld-Italic.woff2` into `/fonts`. Until then, Instrument Serif is used as a fallback.

## Files
- `frames1/`: Video 1 as 121 JPG frames, for smooth scrubbing
- `video/`: Videos 2 and 3 (MP4, with a WebM fallback), audio removed
- `vendor/mediapipe/`: the hand-tracking model and runtime, bundled so nothing loads from a CDN
