import { AdaptivePointFilter, OffhandGesture, PinchGate, selectHandRoles, recognizedHandPose, handNearFace, pinchRatio, isIPhoneCamera, listCameraDevicesWithPermission, openCameraStream, waitForVideoFrame, requestWideZoom, findPencilMarker, mapCameraPoint } from './tracking.mjs?v=20260925-navigation';
import { BoardViewport, NavigationGesture } from './viewport.mjs?v=20260925-navigation';
import { createPdfFromJpeg } from './pdf.mjs';
import { createCloud, isFirebaseConfigured } from './cloud.mjs';
import { firebaseConfig } from './firebase-config.js';
import { findInkLineBounds } from './recognition.mjs?v=20260924-handwriting';

const $ = (selector) => document.querySelector(selector);
const canvas = $('#board');
const ctx = canvas.getContext('2d');
const video = $('#cameraVideo');
const overlay = $('#cameraOverlay');
const overlayCtx = overlay.getContext('2d');
const cursor = $('#handCursor');
const STORAGE_KEY = 'mirrorboard-v1';
const NOTES_KEY = 'mirrorboard-notes-v1';
const NAME_KEY = 'mirrorboard-name-v1';
const THEME_KEY = 'mirrorboard-theme-v1';
const colors = ['#172a33', '#e87355', '#5287ab', '#7b9871'];
const state = {
  strokes: [], redo: [], notes: [], current: null, tool: 'pen', color: colors[0], size: 5,
  name: 'Untitled board', theme: 'light', user: null, cloudReady: false,
  mode: 'computer', stream: null, landmarker: null, faceDetector: null, faceBox: null, faceCheckedAt: 0, lastFaceAt: 0, running: false, frameId: 0,
  lastVideoTime: -1, dominantWrist: null, drawingHandLabel: null, lastHandSeenAt: 0,
  pinchGate: new PinchGate(), pointFilter: new AdaptivePointFilter(), pendingCameraStart: null,
  offhandGesture: new OffhandGesture(), lastGestureAt: 0,
  cameraId: '', pencil: false, cameraToken: 0, cameraStarting: false,
  viewport: new BoardViewport(), navigation: new NavigationGesture(), pointerPan: null
};
let cloud = null;
let cloudSaveQueue = Promise.resolve();

function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove('show'), 3000);
}

function setStatus(text, kind = '') {
  $('#trackingStatus').textContent = text;
  $('#statusLight').className = `status-light ${kind}`;
}

function saveLocalBoard() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.strokes));
    localStorage.setItem(NOTES_KEY, JSON.stringify(state.notes));
    localStorage.setItem(NAME_KEY, state.name);
    $('#saveState').textContent = 'Saved locally';
  } catch { $('#saveState').textContent = 'Storage full'; }
}

function boardSnapshot() {
  state.lastSnapshotAt = Math.max(Date.now(), (state.lastSnapshotAt || 0) + 1);
  return JSON.parse(JSON.stringify({ name: state.name, strokes: state.strokes, notes: state.notes, updatedAt: state.lastSnapshotAt }));
}

function queueCloudSave() {
  if (!cloud || !state.user || !state.cloudReady) return;
  const uid = state.user.uid;
  const snapshot = boardSnapshot();
  const draftKey = `mirrorboard-cloud-draft-${uid}`;
  try { localStorage.setItem(draftKey, JSON.stringify(snapshot)); } catch { /* Cloud still receives the board. */ }
  $('#saveState').textContent = 'Syncing…';
  cloudSaveQueue = cloudSaveQueue.catch(() => {}).then(async () => {
    await cloud.saveBoard(uid, snapshot);
    try {
      const draft = JSON.parse(localStorage.getItem(draftKey) || 'null');
      if (draft?.updatedAt === snapshot.updatedAt) localStorage.removeItem(draftKey);
    } catch { /* Ignore unavailable local storage. */ }
    if (state.user?.uid === uid) $('#saveState').textContent = 'Synced';
  }).catch(error => {
    console.error(error);
    if (state.user?.uid === uid) $('#saveState').textContent = 'Sync pending';
  });
}

function markSaved() {
  if (state.user && state.cloudReady) queueCloudSave();
  else saveLocalBoard();
}

function loadSaved() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    if (Array.isArray(saved)) state.strokes = saved.filter(s => s && Array.isArray(s.points) && ['pen', 'eraser'].includes(s.tool));
    const notes = JSON.parse(localStorage.getItem(NOTES_KEY) || '[]');
    if (Array.isArray(notes)) state.notes = notes.filter(n => n && typeof n.text === 'string');
    state.name = localStorage.getItem(NAME_KEY)?.trim() || 'Untitled board';
    $('#boardName').value = state.name;
  } catch { /* Start with an empty board when stored data is invalid. */ }
}

function setTheme(theme) {
  state.theme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = state.theme;
  document.querySelector('meta[name="theme-color"]').content = state.theme === 'dark' ? '#10191e' : '#f5f2ed';
  $('#themeButton').textContent = state.theme === 'dark' ? '☀' : '☾';
  $('#themeButton').setAttribute('aria-label', state.theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
  try { localStorage.setItem(THEME_KEY, state.theme); } catch { /* Theme remains active for this visit. */ }
  redraw();
}

function resizeBoard() {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  redraw();
}

function renderStroke(target, stroke, width, height, overrideColor = null) {
  const points = stroke.points;
  if (!points.length) return;
  target.save();
  if (target === ctx) {
    target.translate(state.viewport.x * width, state.viewport.y * height);
    target.scale(state.viewport.zoom, state.viewport.zoom);
  }
  target.globalCompositeOperation = stroke.tool === 'eraser' ? 'destination-out' : 'source-over';
  const displayColors = { '#172a33': '#e9f1ec', '#5287ab': '#9ac9e0', '#7b9871': '#b4d3a9' };
  const color = overrideColor || (target === ctx && state.theme === 'dark' && stroke.tool === 'pen' ? (displayColors[stroke.color] || stroke.color) : stroke.color);
  target.strokeStyle = color;
  target.fillStyle = color;
  target.lineWidth = stroke.tool === 'eraser' ? Math.max(stroke.size * 3, 18) : stroke.size;
  target.lineCap = 'round';
  target.lineJoin = 'round';
  if (points.length === 1) {
    target.beginPath();
    target.arc(points[0].x * width, points[0].y * height, target.lineWidth / 2, 0, Math.PI * 2);
    target.fill();
  } else {
    target.beginPath();
    target.moveTo(points[0].x * width, points[0].y * height);
    for (let i = 1; i < points.length; i++) target.lineTo(points[i].x * width, points[i].y * height);
    target.stroke();
  }
  target.restore();
}

function redraw() {
  const { width, height } = canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, width, height);
  for (const stroke of state.strokes) renderStroke(ctx, stroke, width, height);
  if (state.current) renderStroke(ctx, state.current, width, height);
  updateBoardControls();
  $('#zoomValue').textContent = `${Math.round(state.viewport.zoom * 100)}%`;
  $('#boardWrap').style.setProperty('--grid-size', `${24 * state.viewport.zoom}px`);
  $('#boardWrap').style.setProperty('--grid-x', `${state.viewport.x * width}px`);
  $('#boardWrap').style.setProperty('--grid-y', `${state.viewport.y * height}px`);
}

function updateBoardControls() {
  $('#emptyState').classList.toggle('hidden', state.strokes.length > 0 || !!state.current);
  $('#strokeCount').textContent = state.strokes.length;
  $('#undoButton').disabled = state.strokes.length === 0;
  $('#redoButton').disabled = state.redo.length === 0;
}

function beginStroke(point, tool = state.tool) {
  if (state.current) finishStroke();
  state.current = { tool, color: state.color, size: state.size, points: [point] };
  const { width, height } = canvas.getBoundingClientRect();
  renderStroke(ctx, state.current, width, height);
  updateBoardControls();
}

function continueStroke(point) {
  if (!state.current) return;
  const last = state.current.points.at(-1);
  if (Math.hypot(point.x - last.x, point.y - last.y) < .0015) return;
  state.current.points.push(point);
  const { width, height } = canvas.getBoundingClientRect();
  renderStroke(ctx, { ...state.current, points: [last, point] }, width, height);
}

function finishStroke() {
  if (!state.current) return;
  state.strokes.push(state.current);
  state.current = null;
  state.redo = [];
  updateBoardControls();
  markSaved();
}

function undo() {
  finishStroke();
  if (!state.strokes.length) return;
  state.redo.push(state.strokes.pop());
  redraw(); markSaved();
}

function redo() {
  if (!state.redo.length) return;
  state.strokes.push(state.redo.pop());
  redraw(); markSaved();
}

function setTool(tool) {
  finishStroke(); state.tool = tool;
  document.querySelectorAll('[data-tool]').forEach(button => button.classList.toggle('is-active', button.dataset.tool === tool));
  canvas.style.cursor = tool === 'pan' ? 'grab' : tool === 'eraser' ? 'cell' : 'crosshair';
}

function setColor(color) {
  state.color = color; setTool('pen');
  document.querySelectorAll('[data-color]').forEach(button => button.classList.toggle('is-active', button.dataset.color === color));
}

function screenPointFromEvent(event) {
  const rect = canvas.getBoundingClientRect();
  return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
}
const pointFromEvent = event => state.viewport.toWorld(screenPointFromEvent(event));

canvas.addEventListener('pointerdown', event => {
  if (event.button !== 0 && event.button !== 1) return;
  canvas.setPointerCapture(event.pointerId);
  if (state.tool === 'pan' || event.button === 1) {
    finishStroke(); state.pointerPan = { id: event.pointerId, point: screenPointFromEvent(event) };
    canvas.style.cursor = 'grabbing'; return;
  }
  beginStroke(pointFromEvent(event));
});
canvas.addEventListener('pointermove', event => {
  if (state.pointerPan?.id === event.pointerId) {
    const point = screenPointFromEvent(event);
    state.viewport.pan(point.x - state.pointerPan.point.x, point.y - state.pointerPan.point.y);
    state.pointerPan.point = point; redraw(); return;
  }
  if (state.current && canvas.hasPointerCapture(event.pointerId)) continueStroke(pointFromEvent(event));
});
function endPointer() { state.pointerPan = null; finishStroke(); canvas.style.cursor = state.tool === 'pan' ? 'grab' : state.tool === 'eraser' ? 'cell' : 'crosshair'; }
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('lostpointercapture', endPointer);
canvas.addEventListener('wheel', event => {
  event.preventDefault(); finishStroke();
  const rect = canvas.getBoundingClientRect();
  if (event.ctrlKey || event.metaKey) state.viewport.zoomAt(state.viewport.zoom * Math.exp(-event.deltaY * .008), screenPointFromEvent(event));
  else state.viewport.pan(-(event.shiftKey ? event.deltaY : event.deltaX) / rect.width, -(event.shiftKey ? 0 : event.deltaY) / rect.height);
  redraw();
}, { passive: false });
$('#zoomIn').addEventListener('click', () => { finishStroke(); state.viewport.zoomAt(state.viewport.zoom * 1.25); redraw(); });
$('#zoomOut').addEventListener('click', () => { finishStroke(); state.viewport.zoomAt(state.viewport.zoom / 1.25); redraw(); });
$('#resetView').addEventListener('click', () => { finishStroke(); state.viewport.reset(); redraw(); });
$('#pairHandButton').addEventListener('click', () => {
  finishStroke(); state.drawingHandLabel = null; state.dominantWrist = null; state.offhandGesture.reset(); state.navigation.reset();
  $('#gestureStatus').textContent = 'Pinch with your drawing hand to pair it. Then use the other hand for shortcuts.';
  toast('Pinch with your drawing hand to pair it');
});

document.querySelectorAll('[data-tool]').forEach(button => button.addEventListener('click', () => setTool(button.dataset.tool)));
document.querySelectorAll('[data-color]').forEach(button => button.addEventListener('click', () => setColor(button.dataset.color)));
$('#brushSize').addEventListener('input', event => { state.size = Number(event.target.value); $('#brushValue').textContent = state.size; });
$('#undoButton').addEventListener('click', undo);
$('#redoButton').addEventListener('click', redo);
$('#clearButton').addEventListener('click', () => { if (state.strokes.length) $('#clearDialog').showModal(); });
$('#clearDialog').addEventListener('close', () => {
  if ($('#clearDialog').returnValue !== 'clear') return;
  finishStroke(); state.strokes = []; state.redo = []; redraw(); markSaved(); toast('Board cleared');
});
$('#helpButton').addEventListener('click', () => $('#helpDialog').showModal());

document.addEventListener('keydown', event => {
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
  if (typing || event.defaultPrevented) return;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); }
  else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); }
  else if (!event.metaKey && !event.ctrlKey && event.key.toLowerCase() === 'p') setTool('pen');
  else if (!event.metaKey && !event.ctrlKey && event.key.toLowerCase() === 'e') setTool('eraser');
});

function makeInkCanvas(scale = 2, blackInk = false) {
  const { width, height } = canvas.getBoundingClientRect();
  let left = 0, top = 0, right = 1, bottom = 1;
  for (const stroke of state.strokes) {
    if (stroke.tool === 'eraser') continue;
    for (const point of stroke.points) {
      left = Math.min(left, point.x - .03); top = Math.min(top, point.y - .03);
      right = Math.max(right, point.x + .03); bottom = Math.max(bottom, point.y + .03);
    }
  }
  scale = Math.min(scale, 4096 / (width * (right - left)), 4096 / (height * (bottom - top)));
  const ink = document.createElement('canvas');
  ink.width = Math.max(1, Math.round(width * (right - left) * scale));
  ink.height = Math.max(1, Math.round(height * (bottom - top) * scale));
  const inkCtx = ink.getContext('2d', { willReadFrequently: blackInk });
  inkCtx.scale(scale, scale); inkCtx.translate(-left * width, -top * height);
  for (const stroke of state.strokes) renderStroke(inkCtx, stroke, width, height, blackInk ? '#111111' : null);
  return ink;
}

function makeImageCanvas(scale = 2) {
  const ink = makeInkCanvas(scale);
  const image = document.createElement('canvas'); image.width = ink.width; image.height = ink.height;
  const imageCtx = image.getContext('2d');
  imageCtx.fillStyle = '#ffffff'; imageCtx.fillRect(0, 0, image.width, image.height);
  imageCtx.drawImage(ink, 0, 0);
  return image;
}

function makeRecognitionLines() {
  const ink = makeInkCanvas(3, true);
  const inkCtx = ink.getContext('2d', { willReadFrequently: true });
  const bounds = findInkLineBounds(inkCtx.getImageData(0, 0, ink.width, ink.height).data, ink.width, ink.height);
  return bounds.map(({ left, top, right, bottom }) => {
    const line = document.createElement('canvas');
    line.width = right - left;
    line.height = bottom - top;
    const lineCtx = line.getContext('2d');
    lineCtx.fillStyle = '#ffffff';
    lineCtx.fillRect(0, 0, line.width, line.height);
    lineCtx.drawImage(ink, left, top, line.width, line.height, 0, 0, line.width, line.height);
    return line;
  });
}

function downloadBlob(blob, extension) {
  const link = document.createElement('a');
  const filename = state.name.trim().replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'mirrorboard';
  link.href = URL.createObjectURL(blob);
  link.download = `${filename}.${extension}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 30000);
}

$('#exportPngButton').addEventListener('click', () => {
  finishStroke();
  makeImageCanvas().toBlob(blob => { if (blob) { downloadBlob(blob, 'png'); toast('PNG exported'); } }, 'image/png');
  $('#exportMenu').open = false;
});

$('#exportPdfButton').addEventListener('click', () => {
  finishStroke();
  const image = makeImageCanvas(2);
  const pdf = createPdfFromJpeg(image.toDataURL('image/jpeg', .94), image.width, image.height);
  downloadBlob(pdf, 'pdf'); toast('PDF exported');
  $('#exportMenu').open = false;
});

$('#themeButton').addEventListener('click', () => setTheme(state.theme === 'dark' ? 'light' : 'dark'));
$('#boardName').addEventListener('change', event => {
  state.name = event.target.value.trim() || 'Untitled board';
  event.target.value = state.name;
  markSaved();
});
$('#boardName').addEventListener('keydown', event => { if (event.key === 'Enter') event.target.blur(); });

function renderNotes() {
  const list = $('#notesList'); list.replaceChildren();
  state.notes.forEach(note => {
    const card = document.createElement('div'); card.className = 'note-card';
    const header = document.createElement('div'); header.className = 'note-card-header';
    const date = document.createElement('span'); date.textContent = new Date(note.created).toLocaleString();
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.setAttribute('aria-label', 'Delete note');
    remove.addEventListener('click', () => { state.notes = state.notes.filter(n => n.id !== note.id); saveNotes(); renderNotes(); });
    header.append(date, remove);
    const input = document.createElement('textarea'); input.value = note.text; input.setAttribute('aria-label', 'Recognized note');
    input.addEventListener('input', () => { note.text = input.value; saveNotes(); });
    card.append(header, input); list.append(card);
  });
}

function saveNotes() {
  markSaved();
}

function applyBoard(board) {
  state.name = typeof board.name === 'string' && board.name.trim() ? board.name.trim() : 'Untitled board';
  state.strokes = Array.isArray(board.strokes) ? board.strokes.filter(stroke => stroke && Array.isArray(stroke.points)) : [];
  state.notes = Array.isArray(board.notes) ? board.notes.filter(note => note && typeof note.text === 'string') : [];
  state.redo = [];
  $('#boardName').value = state.name;
  redraw(); renderNotes();
}

function renderAccountState() {
  const signedIn = !!state.user;
  $('#authForm').hidden = signedIn || !cloud;
  $('#signedInPanel').hidden = !signedIn;
  $('#accountButton').textContent = signedIn ? state.user.email || 'Account' : 'Sign in';
  $('#accountButton').title = signedIn ? state.user.email || 'Account' : 'Sign in';
  $('#accountTitle').textContent = signedIn ? 'Your account' : 'Sign in to sync';
  $('#accountIntro').textContent = signedIn ? 'This board and your notes are saved to your account when sync is available.' : 'Save your board and notes across devices. Your local board stays on this device.';
  $('#accountEmail').textContent = state.user?.email || '';
}

function friendlyAuthError(error) {
  const code = error?.code || '';
  if (code.includes('invalid-credential') || code.includes('wrong-password') || code.includes('user-not-found')) return 'Email or password is incorrect.';
  if (code.includes('email-already-in-use')) return 'An account already uses this email. Try signing in.';
  if (code.includes('weak-password')) return 'Use a password with at least 6 characters.';
  if (code.includes('too-many-requests')) return 'Too many attempts. Try again later.';
  if (code.includes('network-request-failed')) return 'Connection failed. Check your internet connection.';
  return 'Account request failed. Please try again.';
}

async function handleAuthChange(user) {
  if (!user) {
    state.user = null; state.cloudReady = false;
    loadSaved(); redraw(); renderNotes(); renderAccountState();
    $('#saveState').textContent = 'Saved locally';
    return;
  }
  state.user = user; state.cloudReady = false; renderAccountState();
  $('#saveState').textContent = 'Loading cloud…';
  try {
    const remote = await cloud.loadBoard(user.uid);
    if (state.user?.uid !== user.uid) return;
    let draft = null;
    try { draft = JSON.parse(localStorage.getItem(`mirrorboard-cloud-draft-${user.uid}`) || 'null'); } catch { /* No local draft. */ }
    const useDraft = draft && (!remote || Number(draft.updatedAt) > Number(remote.updatedAt || 0));
    if (useDraft) applyBoard(draft);
    else if (remote) applyBoard(remote);
    state.cloudReady = true;
    $('#saveState').textContent = remote && !useDraft ? 'Synced' : 'Syncing…';
    $('#accountSyncStatus').textContent = 'Your board and notes are available on your signed-in devices.';
    if (!remote || useDraft) queueCloudSave();
  } catch (error) {
    console.error(error);
    state.cloudReady = false;
    $('#saveState').textContent = 'Cloud unavailable';
    $('#accountSyncStatus').textContent = 'Cloud sync is unavailable. Your local board remains on this device.';
  }
}

$('#accountButton').addEventListener('click', () => { $('#authMessage').textContent = ''; $('#accountDialog').showModal(); });
$('#closeAccount').addEventListener('click', () => $('#accountDialog').close());
$('#authForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!cloud) return;
  const button = $('#signInButton'); button.disabled = true; $('#authMessage').textContent = 'Signing in…';
  try { await cloud.signIn($('#authEmail').value.trim(), $('#authPassword').value); $('#authPassword').value = ''; $('#accountDialog').close(); }
  catch (error) { $('#authMessage').textContent = friendlyAuthError(error); }
  finally { button.disabled = false; }
});
$('#createAccountButton').addEventListener('click', async () => {
  if (!cloud || !$('#authForm').reportValidity()) return;
  $('#authMessage').textContent = 'Creating account…';
  try { await cloud.createAccount($('#authEmail').value.trim(), $('#authPassword').value); $('#authPassword').value = ''; $('#accountDialog').close(); toast('Account created'); }
  catch (error) { $('#authMessage').textContent = friendlyAuthError(error); }
});
$('#resetPasswordButton').addEventListener('click', async () => {
  if (!cloud) return;
  if (!$('#authEmail').value.trim() || !$('#authEmail').checkValidity()) { $('#authEmail').reportValidity(); return; }
  try { await cloud.resetPassword($('#authEmail').value.trim()); $('#authMessage').textContent = 'If this email has an account, a reset link has been sent.'; }
  catch (error) { $('#authMessage').textContent = friendlyAuthError(error); }
});
$('#signOutButton').addEventListener('click', async () => {
  if (!cloud) return;
  $('#signOutButton').disabled = true;
  try { await cloudSaveQueue; await cloud.signOut(); $('#accountDialog').close(); toast('Signed out'); }
  catch (error) { $('#authMessage').textContent = friendlyAuthError(error); }
  finally { $('#signOutButton').disabled = false; }
});

async function initializeCloud() {
  if (!isFirebaseConfigured(firebaseConfig)) {
    $('#accountUnavailable').hidden = false;
    renderAccountState();
    return;
  }
  $('#accountUnavailable').textContent = 'Connecting account services…';
  $('#accountUnavailable').hidden = false;
  try {
    cloud = await createCloud(firebaseConfig);
    $('#accountUnavailable').hidden = true;
    renderAccountState();
    cloud.onAuthChange(handleAuthChange);
  } catch (error) {
    console.error(error);
    $('#accountUnavailable').textContent = 'Account services could not load. Check your Firebase settings and connection.';
    $('#accountUnavailable').hidden = false;
    renderAccountState();
  }
}

async function loadTesseract() {
  if (window.Tesseract) return window.Tesseract;
  await new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
    script.onload = resolve; script.onerror = reject; document.head.append(script);
  });
  return window.Tesseract;
}

let handwritingPipelinePromise;
async function loadHandwritingPipeline() {
  if (!handwritingPipelinePromise) {
    handwritingPipelinePromise = (async () => {
      const { pipeline, env } = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1');
      env.allowLocalModels = false;
      return pipeline('image-to-text', 'Xenova/trocr-small-handwritten', {
        dtype: 'q8',
        progress_callback: progress => {
          if (progress.status === 'progress' && Number.isFinite(progress.progress)) {
            $('#notesFeedback').textContent = `Downloading handwriting model… ${Math.round(progress.progress)}%`;
          }
        }
      });
    })().catch(error => { handwritingPipelinePromise = null; throw error; });
  }
  return handwritingPipelinePromise;
}

async function recognizePrinted(lines) {
  const Tesseract = await loadTesseract();
  const worker = await Tesseract.createWorker('eng', 1, { logger: message => {
    if (message.status === 'recognizing text') $('#notesFeedback').textContent = `Reading printed ink… ${Math.round((message.progress || 0) * 100)}%`;
  }});
  try {
    await worker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.SINGLE_LINE, preserve_interword_spaces: '1' });
    const text = [];
    for (let i = 0; i < lines.length; i++) {
      $('#notesFeedback').textContent = `Reading printed line ${i + 1} of ${lines.length}…`;
      const result = await worker.recognize(lines[i]);
      text.push(result.data.text.trim());
    }
    return text.filter(Boolean).join('\n');
  } finally {
    await worker.terminate();
  }
}

async function recognizeHandwriting(lines) {
  const recognize = await loadHandwritingPipeline();
  const text = [];
  for (let i = 0; i < lines.length; i++) {
    $('#notesFeedback').textContent = `Reading handwritten line ${i + 1} of ${lines.length}…`;
    const result = await recognize(lines[i].toDataURL('image/png'));
    text.push(result[0]?.generated_text?.trim() || '');
  }
  return text.filter(Boolean).join('\n');
}

$('#captureButton').addEventListener('click', async () => {
  finishStroke();
  if (!state.strokes.length) { toast('Write something on the board first'); return; }
  const button = $('#captureButton'); button.disabled = true;
  const handwriting = $('#recognitionMode').value === 'handwriting';
  $('#notesFeedback').textContent = 'Preparing ink for recognition…';
  try {
    const lines = makeRecognitionLines();
    if (!lines.length) { $('#notesFeedback').textContent = 'No writing found. Try writing larger letters.'; return; }
    let recognized;
    let usedPrintedFallback = false;
    if (handwriting) {
      try {
        recognized = await recognizeHandwriting(lines);
      } catch (error) {
        console.error('Handwriting model failed', error);
        $('#notesFeedback').textContent = 'Handwriting model unavailable; trying printed text recognition…';
        usedPrintedFallback = true;
        recognized = await recognizePrinted(lines);
      }
    } else {
      recognized = await recognizePrinted(lines);
    }
    if (!recognized) { $('#notesFeedback').textContent = 'No text recognized. Try larger writing with clear space between lines.'; return; }
    state.notes.unshift({ id: crypto.randomUUID(), created: Date.now(), text: recognized });
    saveNotes(); renderNotes();
    $('#notesFeedback').textContent = usedPrintedFallback
      ? 'Handwriting model was unavailable. This note used printed-text recognition; review it below.'
      : 'Note captured. You can edit the text below.';
    toast('Writing recognized');
  } catch (error) {
    console.error(error); $('#notesFeedback').textContent = 'Recognition could not load. Check your connection and try again.';
  } finally {
    button.disabled = false;
  }
});

function setMode(mode) {
  if (state.mode === mode) return;
  finishStroke(); state.pinchGate.reset(); state.pointFilter.reset(); state.offhandGesture.reset(); state.pendingCameraStart = null;
  state.mode = mode; state.cameraId = '';
  document.querySelectorAll('[data-mode]').forEach(button => button.classList.toggle('is-active', button.dataset.mode === mode));
  $('#cameraModeSelect').value = mode;
  $('#cameraBox').classList.toggle('is-mirrored', mode === 'computer');
  $('#modeDescription').textContent = mode === 'iphone'
      ? 'On a Mac, lock your nearby iPhone and select its Continuity Camera below. On iPhone, use the rear camera.'
    : 'Computer camera preview is mirrored. Keep your hands away from your face to draw or use shortcuts.';
  $('#gestureHint').textContent = 'Touch fingertips to draw · separate to stop';
  updateCameraList();
  if (state.running || state.cameraStarting) restartCamera();
}
document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => setMode(button.dataset.mode)));
$('#cameraModeSelect').addEventListener('change', event => setMode(event.target.value));
$('#pencilToggle').addEventListener('change', event => { state.pencil = event.target.checked; toast(state.pencil ? 'Pencil marker tracking on' : 'Pencil marker tracking off'); });
$('#cameraSelect').addEventListener('change', event => { state.cameraId = event.target.value; if (state.running || state.cameraStarting) restartCamera(); });

const isOnIPhone = /iPhone|iPad|iPod/i.test(navigator.userAgent);

async function updateCameraList(providedDevices = null) {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    const devices = (Array.isArray(providedDevices) ? providedDevices : await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'videoinput');
    const select = $('#cameraSelect');
    const matching = devices.filter(device => device.label && (state.mode === 'iphone' ? isOnIPhone || isIPhoneCamera(device) : !isIPhoneCamera(device)));
    const labelsAvailable = devices.some(device => device.label);
    const defaultLabel = state.mode === 'iphone'
      ? isOnIPhone ? 'Auto-select rear camera' : matching.length ? 'Auto-select iPhone camera' : labelsAvailable ? 'iPhone camera not found — Find cameras' : 'Find cameras to detect iPhone'
      : matching.length ? 'Auto-select computer camera' : 'Find cameras to identify sources';
    select.replaceChildren(new Option(defaultLabel, ''));
    matching.forEach(device => select.add(new Option(device.label, device.deviceId)));
    select.value = matching.some(device => device.deviceId === state.cameraId) ? state.cameraId : '';
  } catch { /* Device labels may remain hidden until permission is granted. */ }
}
navigator.mediaDevices?.addEventListener?.('devicechange', () => updateCameraList());
$('#refreshCameras').addEventListener('click', async () => {
  const button = $('#refreshCameras');
  button.disabled = true;
  let timeout;
  try {
    const devices = await Promise.race([
      state.stream ? navigator.mediaDevices.enumerateDevices() : listCameraDevicesWithPermission(navigator.mediaDevices, true),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Camera permission timed out')), 20000); })
    ]);
    await updateCameraList(devices);
    const found = devices.some(device => device.kind === 'videoinput' && device.label && (state.mode === 'iphone' ? isOnIPhone || isIPhoneCamera(device) : !isIPhoneCamera(device)));
    toast(found ? 'Camera list updated' : state.mode === 'iphone' ? 'No iPhone camera found. Lock your phone and keep it nearby.' : 'No computer camera found');
  } catch (error) {
    console.error(error);
    toast(error.name === 'NotAllowedError' ? 'Allow camera access to list devices' : error.message === 'Camera permission timed out' ? 'Camera permission is still waiting; check your browser prompt' : 'Could not refresh cameras');
  } finally {
    clearTimeout(timeout);
    button.disabled = false;
  }
});

async function loadLandmarker() {
  if (state.landmarker) return state.landmarker;
  const { FilesetResolver, GestureRecognizer } = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/+esm');
  const vision = await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm');
  state.landmarker = await GestureRecognizer.createFromOptions(vision, {
    baseOptions: { modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task', delegate: 'GPU' },
    runningMode: 'VIDEO', numHands: 2, minHandDetectionConfidence: .55, minHandPresenceConfidence: .55, minTrackingConfidence: .55
  }).catch(async () => GestureRecognizer.createFromOptions(vision, {
    baseOptions: { modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task', delegate: 'CPU' },
    runningMode: 'VIDEO', numHands: 2
  }));
  return state.landmarker;
}

async function loadFaceDetector() {
  if (state.faceDetector) return state.faceDetector;
  const { FilesetResolver, FaceDetector } = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/+esm');
  const vision = await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm');
  state.faceDetector = await FaceDetector.createFromOptions(vision, {
    baseOptions: { modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite', delegate: 'CPU' },
    runningMode: 'VIDEO', minDetectionConfidence: .5
  });
  return state.faceDetector;
}

async function startCamera() {
  const token = ++state.cameraToken;
  if (!navigator.mediaDevices?.getUserMedia) { setStatus('Camera unavailable', 'error'); toast('Use HTTPS or localhost for camera access'); return; }
  state.cameraStarting = true;
  $('#cameraButtonText').textContent = 'Cancel camera start'; $('#cameraButton').disabled = false;
  $('#cameraMessage').textContent = 'Requesting the selected camera…';
  setStatus('Starting camera');
  try {
    const opened = await openCameraStream(navigator.mediaDevices, state.mode, state.cameraId, isOnIPhone);
    const selected = opened.selected;
    let stream = opened.stream;
    if (token !== state.cameraToken) { stream.getTracks().forEach(track => track.stop()); return; }
    state.stream = stream;
    let videoTrack = stream.getVideoTracks()[0];
    const activeLabel = videoTrack?.label || '';
    if (state.mode === 'iphone' && !isOnIPhone && !isIPhoneCamera(selected) && activeLabel && !isIPhoneCamera({ label: activeLabel }))
      throw Object.assign(new Error('Selected camera is not an iPhone'), { name: 'IPhoneCameraNotFound' });
    if (state.mode === 'computer' && activeLabel && isIPhoneCamera({ label: activeLabel }))
      throw Object.assign(new Error('Selected camera is an iPhone'), { name: 'ComputerCameraNotFound' });
    if (selected?.deviceId) state.cameraId = selected.deviceId;
    video.srcObject = stream;
    setStatus(state.mode === 'iphone' && !isOnIPhone ? 'Connecting Continuity Camera' : 'Connecting camera');
    try { await waitForVideoFrame(video, state.mode === 'iphone' ? 15000 : 7000); }
    catch (error) {
      if (token !== state.cameraToken || state.mode !== 'iphone' || error.name !== 'NoVideoFrames') throw error;
      stream.getTracks().forEach(track => track.stop()); video.srcObject = null;
      setStatus('Retrying iPhone connection');
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: selected?.deviceId ? { deviceId: { exact: selected.deviceId } } : { facingMode: 'environment' } });
      if (token !== state.cameraToken) { stream.getTracks().forEach(track => track.stop()); return; }
      state.stream = stream; videoTrack = stream.getVideoTracks()[0]; video.srcObject = stream;
      await waitForVideoFrame(video, 15000);
    }
    if (token !== state.cameraToken) return;
    const zoomStatus = await requestWideZoom(videoTrack);
    if (token !== state.cameraToken) return;
    $('#zoomStatus').textContent = zoomStatus === 'active' ? '0.5× camera zoom active' : '0.5× is unavailable here; use camera or Mac Video Effects controls';
    $('#cameraMessage').textContent = `${selected?.label || videoTrack?.label || 'Camera'} · ${video.videoWidth} × ${video.videoHeight}`;
    await updateCameraList();
    state.running = true;
    state.cameraStarting = false;
    $('#cameraBox').classList.add('active');
    $('#cameraButtonText').textContent = 'Stop camera'; $('#cameraButton').disabled = false;
    videoTrack?.addEventListener('ended', () => {
      if (state.stream !== stream) return;
      stopCamera(); setStatus('Camera disconnected', 'error'); toast('Reconnect the camera, then start it again');
    }, { once: true });
    setStatus('Loading hand tracking');
    try { await loadLandmarker(); }
    catch (error) {
      if (token !== state.cameraToken) return;
      console.error(error);
      setStatus('Camera live · hand tracking unavailable', 'error');
      $('#cameraMessage').textContent += ' · Hand model could not load. Stop and restart to retry.';
      return;
    }
    if (token !== state.cameraToken) return;
    if (state.mode === 'computer') {
      try { await loadFaceDetector(); }
      catch (error) { console.warn('Face guard unavailable', error); $('#modeDescription').textContent = 'Face guard unavailable. Keep your hand away from your face while drawing.'; }
    }
    if (token !== state.cameraToken) return;
    state.running = true; state.lastVideoTime = -1;
    $('#cameraBox').classList.add('active');
    $('#cameraButtonText').textContent = 'Stop camera'; $('#cameraButton').disabled = false;
    setStatus('Looking for hands', 'live');
    processFrame();
  } catch (error) {
    if (token !== state.cameraToken) return;
    console.error(error); stopCamera();
    $('#cameraMessage').textContent = `${error.name}: ${error.message || 'Camera startup failed'}`;
    const iphoneMissing = error.name === 'IPhoneCameraNotFound';
    const computerMissing = error.name === 'ComputerCameraNotFound';
    const noFrames = error.name === 'NoVideoFrames';
    setStatus(iphoneMissing ? 'iPhone camera not found' : noFrames ? 'Camera has no video' : computerMissing ? 'Computer camera not found' : error.name === 'NotAllowedError' ? 'Camera permission denied' : 'Camera could not start', 'error');
    toast(iphoneMissing ? 'Lock your iPhone, keep it near the Mac, then try again' : noFrames ? (state.mode === 'iphone' && !isOnIPhone ? 'No video arrived. Unlock then lock your iPhone or reconnect it' : 'No video arrived. Reconnect the selected camera and try again') : computerMissing ? 'Choose a computer camera in Camera source' : error.name === 'NotAllowedError' ? 'Allow camera access and try again' : 'Check the camera and your connection');
  }
}

function stopCamera() {
  state.cameraToken++;
  state.cameraStarting = false;
  state.running = false; cancelAnimationFrame(state.frameId); finishStroke();
  state.pinchGate.reset(); state.pointFilter.reset(); state.offhandGesture.reset(); state.navigation.reset(); state.pendingCameraStart = null; state.lastHandSeenAt = 0; state.dominantWrist = null; state.drawingHandLabel = null; state.faceBox = null; state.faceCheckedAt = 0; state.lastFaceAt = 0;
  state.stream?.getTracks().forEach(track => track.stop()); state.stream = null;
  video.srcObject = null; overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
  cursor.style.display = 'none'; $('#cameraBox').classList.remove('active');
  $('#zoomStatus').textContent = '0.5× wide view requested when the camera supports it';
  $('#cameraButtonText').textContent = 'Start camera'; $('#cameraButton').disabled = false;
  setStatus('Camera off');
}

function restartCamera() { stopCamera(); startCamera(); }
$('#cameraButton').addEventListener('click', () => state.running || state.cameraStarting ? stopCamera() : startCamera());

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function chooseHands(hands, handednesses, poses) {
  const roles = selectHandRoles(hands, handednesses, state.dominantWrist, state.drawingHandLabel, poses);
  if (roles.drawing) state.dominantWrist = roles.drawing[0];
  state.drawingHandLabel = roles.drawingLabel;
  return [roles.drawing, roles.offhand];
}

function updateFaceBox(now) {
  if (state.mode !== 'computer' || !state.faceDetector || now - state.faceCheckedAt < 140) return;
  state.faceCheckedAt = now;
  try {
    const detections = state.faceDetector.detectForVideo(video, now).detections || [];
    const face = detections.map(item => item.boundingBox).filter(Boolean).sort((a, b) => b.width * b.height - a.width * a.height)[0];
    if (face) {
      state.faceBox = { x: face.originX / video.videoWidth, y: face.originY / video.videoHeight, width: face.width / video.videoWidth, height: face.height / video.videoHeight };
      state.lastFaceAt = now;
    } else if (now - state.lastFaceAt > 650) state.faceBox = null;
  } catch (error) {
    console.warn('Face detection stopped', error);
    state.faceDetector = null;
    state.faceBox = null;
    $('#modeDescription').textContent = 'Face guard unavailable. Keep your hand away from your face while drawing.';
  }
}

function isHandAwayFromFace(hand) {
  if (!hand || state.mode !== 'computer') return true;
  if (state.faceBox) return !handNearFace(hand, state.faceBox);
  if (state.faceDetector) return true;
  const palm = hand[9];
  return palm.y > .5 || palm.x < .2 || palm.x > .8;
}

const markerCanvas = document.createElement('canvas'); markerCanvas.width = 160; markerCanvas.height = 90;
const markerCtx = markerCanvas.getContext('2d', { willReadFrequently: true });
function scanMarkers(hand) {
  if (!state.pencil) return null;
  markerCtx.drawImage(video, 0, 0, markerCanvas.width, markerCanvas.height);
  const pixels = markerCtx.getImageData(0, 0, markerCanvas.width, markerCanvas.height).data;
  return findPencilMarker(pixels, markerCanvas.width, markerCanvas.height, hand);
}

function mapToBoard(point) {
  return mapCameraPoint(point, state.mode === 'computer');
}

function handleOffhand(hand, now, pose = null) {
  if (hand && !isHandAwayFromFace(hand)) {
    state.offhandGesture.reset();
    return { pose: 'none', pause: false, action: null };
  }
  const gesture = state.offhandGesture.update(hand, now, pose);
  if (gesture.action === 'undo') {
    state.lastGestureAt = now; undo(); toast('Undid last stroke');
  } else if (gesture.action === 'color') {
    const next = (colors.indexOf(state.color) + 1) % colors.length;
    state.lastGestureAt = now; setColor(colors[next]); toast('Color changed');
  }
  return gesture;
}

function drawLandmarks(hands) {
  const w=video.videoWidth, h=video.videoHeight;
  if (overlay.width!==w || overlay.height!==h) { overlay.width=w; overlay.height=h; }
  overlayCtx.clearRect(0,0,w,h);
  for (const hand of hands) {
    overlayCtx.fillStyle='#c8f1df'; overlayCtx.strokeStyle='#c8f1dfbb'; overlayCtx.lineWidth=2;
    for (const [a,b] of [[0,5],[5,6],[6,7],[7,8],[0,9],[9,10],[10,11],[11,12],[0,13],[13,14],[14,15],[15,16],[0,17],[17,18],[18,19],[19,20],[0,1],[1,2],[2,3],[3,4]]) {
      overlayCtx.beginPath(); overlayCtx.moveTo(hand[a].x*w,hand[a].y*h); overlayCtx.lineTo(hand[b].x*w,hand[b].y*h); overlayCtx.stroke();
    }
    for (const point of [hand[4],hand[8]]) { overlayCtx.beginPath();overlayCtx.arc(point.x*w,point.y*h,5,0,Math.PI*2);overlayCtx.fill(); }
  }
}

function processFrame() {
  if (!state.running) return;
  state.frameId=requestAnimationFrame(processFrame);
  if (video.readyState<2 || video.currentTime===state.lastVideoTime) return;
  state.lastVideoTime=video.currentTime;
  try {
    const now=performance.now();
    updateFaceBox(now);
    const result=state.landmarker.recognizeForVideo(video, now);
    const hands=result.landmarks || [];
    const poses = hands.map((hand, i) => recognizedHandPose(hand, result.gestures?.[i]));
    drawLandmarks(hands);
    $('#gestureStatus').textContent = state.drawingHandLabel
      ? `Drawing: ${state.drawingHandLabel} · ${hands.map((_, i) => `${(result.handednesses || result.handedness)?.[i]?.[0]?.categoryName || 'Hand'}: ${poses[i]}`).join(' · ') || 'No hands visible'}`
      : 'Pinch with your drawing hand to pair it. Keep both hands visible for shortcuts.';
    const available = hands.map((hand, i) => isHandAwayFromFace(hand) ? i : -1).filter(i => i >= 0);
    const navigation = state.navigation.update(available.map(i => hands[i].map(mapToBoard)), available.map(i => poses[i]), now);
    if (navigation && !$('#clearDialog').open) {
      finishStroke(); state.pendingCameraStart = null; state.pinchGate.reset(); state.offhandGesture.reset(); state.pointFilter.reset();
      cursor.style.display = 'none';
      if (!navigation.waiting) {
        if (navigation.mode === 'zoom') state.viewport.zoomAt(state.viewport.zoom * navigation.scale, navigation.center);
        state.viewport.pan(navigation.dx, navigation.dy); redraw();
      }
      setStatus(navigation.waiting ? 'Hold navigation gesture…' : navigation.mode === 'zoom' ? 'Two palms: pan and zoom' : 'Two fingers: drag / scroll board', 'live');
      return;
    }
    const previousWrist=state.dominantWrist;
    const [dominant, offhand]=chooseHands(hands, result.handednesses || result.handedness || [], poses);
    const offhandPose = offhand ? poses[hands.indexOf(offhand)] : null;
    if (!dominant) {
      finishStroke(); state.pendingCameraStart=null; state.pinchGate.reset(); state.pointFilter.reset();
      cursor.style.display='none';
      const gesture = handleOffhand(offhand, now, offhandPose);
      setStatus(offhand ? gesture.pose === 'fist' ? 'Hold off-hand fist to undo' : gesture.pose === 'point' ? 'Hold off-hand index finger to change color' : 'Show your drawing hand to draw' : 'Looking for hands', 'live');
      return;
    }
    if (previousWrist && distance(previousWrist,dominant[0])>.22) {
      finishStroke(); state.pendingCameraStart=null; state.pinchGate.reset(); state.pointFilter.reset();
    }
    state.lastHandSeenAt=now;
    const offhandGesture=handleOffhand(offhand,now,offhandPose);
    const marker=scanMarkers(dominant);
    const point=state.pointFilter.update(mapToBoard(marker || dominant[8]),now,mapToBoard(dominant[0]));
    if (state.pointFilter.discontinuity) { finishStroke(); state.pendingCameraStart=null; }
    const rect=canvas.getBoundingClientRect();
    cursor.style.display='block'; cursor.style.left=`${point.x*rect.width}px`; cursor.style.top=`${point.y*rect.height}px`;
    const nearFace = !isHandAwayFromFace(dominant);
    if (nearFace) state.pinchGate.reset();
    const drawing = !nearFace && state.pinchGate.update(pinchRatio(dominant)) && !offhandGesture.pause && !$('#clearDialog').open;
    const tool=marker?.kind==='eraser' ? 'eraser' : marker?.kind==='tip' ? 'pen' : state.tool === 'pan' ? 'pen' : state.tool;
    cursor.classList.toggle('drawing',drawing);cursor.classList.toggle('eraser',tool==='eraser');
    if (drawing) {
      if (state.current?.tool!==tool) finishStroke();
      if (state.current) continueStroke(state.viewport.toWorld(point));
      else if (!state.pendingCameraStart) state.pendingCameraStart=point;
      else if (distance(point,state.pendingCameraStart)>.006) {
        if (!state.drawingHandLabel) state.drawingHandLabel = (result.handednesses || result.handedness)?.[hands.indexOf(dominant)]?.[0]?.categoryName || null;
        beginStroke(state.viewport.toWorld(state.pendingCameraStart),tool); continueStroke(state.viewport.toWorld(point)); state.pendingCameraStart=null;
      }
    } else { finishStroke(); state.pendingCameraStart=null; }
    const gestureHint=offhandGesture.pose==='point' ? ' · Hold pointer to change color' : offhandGesture.pose==='fist' ? ' · Hold fist to undo' : '';
    setStatus((nearFace ? 'Move drawing hand away from face' : offhandGesture.pause ? 'Drawing paused for off-hand shortcut' : drawing ? (tool==='eraser' ? 'Eraser on — move to erase' : 'Pen on — move to draw') : 'Pen off — touch fingertips to draw') + gestureHint,'live');
  } catch (error) { console.error(error); stopCamera(); setStatus('Tracking stopped','error'); toast('Hand tracking stopped. Try restarting the camera.'); }
}

loadSaved(); renderNotes();
let initialTheme = 'light';
try { initialTheme = localStorage.getItem(THEME_KEY) || 'light'; } catch { /* Use the default theme. */ }
setTheme(initialTheme);
initializeCloud();
new ResizeObserver(resizeBoard).observe($('#boardWrap'));
updateCameraList();
