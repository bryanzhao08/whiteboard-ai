# whiteboard-ai

MirrorBoard is a camera-powered whiteboard that also works with a mouse or touch. It opens in **Computer camera** mode with an unmirrored webcam preview. Switch to **iPhone camera** to point your phone at your hands or work surface. On a Mac, iPhone mode selects an iPhone connected through Continuity Camera; it does not silently fall back to the computer webcam. On an iPhone, it requests the rear camera.

## Features

- Track up to two hands with MediaPipe Hand Landmarker. Aim with your index finger; touch thumb and index fingertips and move to draw. The pen turns off as soon as the fingertips separate or tracking loses the hand. A stationary pinch will not leave a dot. Adaptive cursor smoothing reduces hand landmark jitter while keeping deliberate movement responsive.
- Use the other hand to pause (open palm), cycle ink colors (hold an index point for 650 ms), or undo (hold a fist for 350 ms). A two-hand wave opens a clear confirmation.
- Optional marked-pencil tracking: a neon red marker near the front tip moves a pen cursor; a pink marker near the eraser end switches to erasing. Touch thumb and index fingertips while holding the pencil to make a mark. Marker tracking is experimental and depends on lighting and marker colors.
- Request a real 0.5× wide camera view where the browser and camera support it. The camera panel reports whether 0.5× is active, requested without confirmation, or unavailable. On a Mac with Continuity Camera, use [Video Effects](https://support.apple.com/en-us/105117) to select 0.5× or Ultra Wide when the browser cannot set it.
- Draw with mouse or touch, choose colors and brush size, erase, undo, redo, clear, and export a PNG.
- Export the board directly as an A4 PDF. PDF and PNG exports keep a white background even when dark mode is active.
- Switch between light and dark mode; the choice is saved in this browser. Rename the board to set its export filename.
- Recognize handwriting and cursive with a pretrained TrOCR handwriting model. Choose the faster Tesseract.js mode for printed or block letters. Captured notes are editable and saved in this browser.
- The board and notes are saved locally in browser storage. Optional Firebase email accounts sync them across devices. Video frames are processed in the browser and are never uploaded by this app.

## Run locally

No build step is required. Serve this folder on localhost:

```sh
python3 -m http.server 8000
```

Open <http://localhost:8000>. Camera access requires localhost or HTTPS. The first camera use downloads the MediaPipe model and runtime. The first cursive recognition downloads a pretrained handwriting model (tens of MB); printed-text recognition downloads Tesseract and English data. An internet connection is required for those first downloads. Mouse and touch drawing work without them.

To use the iPhone camera on a Mac, set up [Apple Continuity Camera](https://support.apple.com/en-us/102546). Keep the iPhone nearby and locked, with Wi-Fi, Bluetooth, and Continuity Camera enabled. Select **iPhone camera** in MirrorBoard, then press **Start camera**. The browser may first ask for ordinary camera permission so MirrorBoard can reveal device labels. It then selects the iPhone by its exact device ID; it will not silently switch to the Mac webcam. The camera list updates when devices connect or disconnect.

If the iPhone is listed but its preview stays blank, unlock and lock it again, reconnect it, or try a USB connection, then restart the camera. MirrorBoard reports a stream that delivers no video frames. If you open MirrorBoard directly on an iPhone, iPhone mode uses its rear camera.

## Publish with GitHub Pages

The site is static. In the repository's **Settings → Pages**, set **Build and deployment → Source** to **GitHub Actions**. The included workflow tests, builds, and publishes on each push to `main`. The URL will be `https://bryanzhao08.github.io/whiteboard-ai/` unless the repository or account name changes. Pages provides HTTPS, which supports camera permission. The site works without Firebase; guest boards stay in the current browser.

## Enable email sign-in and cloud sync

Firebase setup is needed once; no server is required in this repository.

1. Create a [Firebase project](https://console.firebase.google.com/) and add a Web app. Copy its **web app config** into `firebase-config.js`. The four client settings used are `apiKey`, `authDomain`, `projectId`, and `appId`. They are public app identifiers. Never put a service-account JSON file or admin key in this repository.
2. In Firebase **Authentication → Sign-in method**, enable **Email/Password**. In **Authentication → Settings → Authorized domains**, add `bryanzhao08.github.io` if it is not already listed. Keep `localhost` for local testing.
3. Create a Cloud Firestore database. In **Firestore Database → Rules**, paste the contents of `firestore.rules` and publish the rules. These rules restrict each board to its signed-in owner.
4. Commit and push the updated `firebase-config.js`. GitHub Pages will redeploy automatically. Open the site, choose **Sign in**, then create an account or sign in with email and password. Password reset is available there too.

The first time an account signs in without a cloud board, the current local board is copied into that account. When an existing cloud board is loaded, the local guest board remains on the device and returns after sign-out. Unsynced cloud edits are kept as a local draft and retried on the next sign-in.

## Controls

| Action | Control |
| --- | --- |
| Draw | Mouse/touch drag, or hold a thumb-to-index pinch while moving on camera |
| Move without drawing | Separate thumb and index fingertips; the pen turns off immediately |
| Pause camera drawing | Show an open palm with your second hand |
| Change color | Point with the second hand for 650 ms |
| Undo | Hold a fist with the second hand for 350 ms |
| Clear | Wave both hands, then confirm |
| Keyboard | `P` pen, `E` eraser, `Ctrl/Cmd+Z` undo, `Ctrl/Cmd+Shift+Z` redo |

## Implementation notes

The browser loads MediaPipe Tasks Vision 1.0.1 and Tesseract.js 5.1.1 from pinned CDN URLs. The hand model is loaded from Google's MediaPipe model storage. Hand landmarks are mapped from the unmirrored camera frame to the board. Pencil marker tracking uses simple color detection near the drawing hand and is an optional aid, not a trained pencil detector.

For handwritten notes, the app loads [Xenova/trocr-small-handwritten](https://huggingface.co/Xenova/trocr-small-handwritten) through Transformers.js 3.8.1 and runs inference in your browser. Its source model was already trained on the [IAM handwriting dataset](https://huggingface.co/microsoft/trocr-small-handwritten); this project does not download a raw dataset or train on your writing. The browser downloads and caches model weights on first use. Board images are processed locally and are not sent to Hugging Face. TrOCR expects single-line images, so the app separates lines from the ink before recognition. Leave space between lines; connected or overlapping lines may be read together. If the handwriting model cannot load, the app tries printed-text OCR. Recognition can still make mistakes; edit the note afterward.

Firebase Authentication and Firestore use the pinned Firebase JavaScript SDK 12.19.0 from Google's CDN when a config is present. Cloud sync stores text and vector strokes; it does not upload video. A single Firestore document backs the default board for each account, so extremely large boards may reach Firestore's document-size limit.
