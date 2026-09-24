# whiteboard-ai

MirrorBoard is a camera-powered whiteboard that also works with a mouse or touch. It opens in **Computer camera** mode for a mirrored, front-facing webcam experience. Switch to **iPhone camera** to point your phone at your hands or work surface. On a Mac, iPhone mode selects an iPhone connected through Continuity Camera; it does not silently fall back to the computer webcam. On an iPhone, it requests the rear camera.

## Features

- Track up to two hands with MediaPipe Hand Landmarker. Aim with your index finger; pinch thumb and index finger together and keep them together while moving to draw. Release to turn the pen off. Brief tracking flicker will not split a stroke, and a stationary pinch will not leave a dot.
- Use the other hand to pause (open palm), cycle ink colors (hold an index point), or undo (fist then open palm). A two-hand wave opens a clear confirmation.
- Optional marked-pencil tracking: a bright cyan marker near the tip moves a pen cursor; a pink marker near the eraser switches to erasing. Pinch while holding the pencil to make a mark. Marker tracking is experimental and depends on lighting and marker colors.
- Draw with mouse or touch, choose colors and brush size, erase, undo, redo, clear, and export a PNG.
- Recognize writing on the board with Tesseract.js. Captured notes are editable and saved in this browser.
- The board and notes are saved locally in browser storage. Video frames are processed in the browser and are never uploaded by this app.

## Run locally

No build step is required. Serve this folder on localhost:

```sh
python3 -m http.server 8000
```

Open <http://localhost:8000>. Camera access requires localhost or HTTPS. The first camera use downloads the MediaPipe model and runtime; note recognition downloads the Tesseract runtime and English data. An internet connection is required for those downloads. Mouse and touch drawing work without them.

To use the iPhone camera on a Mac, set up [Apple Continuity Camera](https://support.apple.com/en-us/102546), then select **iPhone camera** in MirrorBoard and start the camera. The iPhone must appear as a camera source on your Mac. If you open MirrorBoard directly on an iPhone, iPhone mode uses its rear camera.

## Publish with GitHub Pages

The site is static. In the repository's **Settings → Pages**, choose **Deploy from a branch**, then select `main` and `/ (root)`. Pages will provide an HTTPS URL, which supports camera permission.

## Controls

| Action | Control |
| --- | --- |
| Draw | Mouse/touch drag, or hold a thumb-to-index pinch while moving on camera |
| Move without drawing | Release the pinch; the pen turns off after a short flicker tolerance |
| Pause camera drawing | Show an open palm with your second hand |
| Change color | Point with the second hand for one second |
| Undo | Make a fist with the second hand, then open the palm |
| Clear | Wave both hands, then confirm |
| Keyboard | `P` pen, `E` eraser, `Ctrl/Cmd+Z` undo, `Ctrl/Cmd+Shift+Z` redo |

## Implementation notes

The browser loads MediaPipe Tasks Vision 1.0.1 and Tesseract.js 5.1.1 from pinned CDN URLs. The hand model is loaded from Google's MediaPipe model storage. Hand landmarks are mapped from the camera frame to the board; Computer camera mode mirrors the horizontal axis. Pencil marker tracking uses simple color detection near the drawing hand and is an optional aid, not a trained pencil detector. OCR works best with large, clear writing and can be corrected in the note editor.
