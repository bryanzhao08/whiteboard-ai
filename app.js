import { AdaptivePointFilter, OffhandGesture, PinchGate, pickDrawingHandIndex, pinchRatio, isIPhoneCamera, pickCameraDevice } from './tracking.mjs';
import { createPdfFromJpeg } from './pdf.mjs';
import { createCloud, isFirebaseConfigured } from './cloud.mjs';
import { firebaseConfig } from './firebase-config.js';

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
  mode: 'computer', stream: null, landmarker: null, running: false, frameId: 0,
  lastVideoTime: -1, dominantWrist: null, lastHandSeenAt: 0,
  pinchGate: new PinchGate(), pointFilter: new AdaptivePointFilter(), pendingCameraStart: null,
  offhandGesture: new OffhandGesture(), lastGestureAt: 0,
  wavePoints: [], cameraId: '', pencil: false, cameraToken: 0
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

function renderStroke(target, stroke, width, height) {
  const points = stroke.points;
  if (!points.length) return;
  target.save();
  target.globalCompositeOperation = stroke.tool === 'eraser' ? 'destination-out' : 'source-over';
  const displayColors = { '#172a33': '#e9f1ec', '#5287ab': '#9ac9e0', '#7b9871': '#b4d3a9' };
  const color = target === ctx && state.theme === 'dark' && stroke.tool === 'pen' ? (displayColors[stroke.color] || stroke.color) : stroke.color;
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
  canvas.style.cursor = tool === 'eraser' ? 'cell' : 'crosshair';
}

function setColor(color) {
  state.color = color; setTool('pen');
  document.querySelectorAll('[data-color]').forEach(button => button.classList.toggle('is-active', button.dataset.color === color));
}

function pointFromEvent(event) {
  const rect = canvas.getBoundingClientRect();
  return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) };
}

canvas.addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  canvas.setPointerCapture(event.pointerId);
  beginStroke(pointFromEvent(event));
});
canvas.addEventListener('pointermove', event => {
  if (state.current && canvas.hasPointerCapture(event.pointerId)) continueStroke(pointFromEvent(event));
});
canvas.addEventListener('pointerup', finishStroke);
canvas.addEventListener('pointercancel', finishStroke);
canvas.addEventListener('lostpointercapture', finishStroke);

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

function makeImageCanvas(scale = 2) {
  const { width, height } = canvas.getBoundingClientRect();
  const image = document.createElement('canvas');
  image.width = Math.round(width * scale); image.height = Math.round(height * scale);
  const ink = document.createElement('canvas'); ink.width = image.width; ink.height = image.height;
  const inkCtx = ink.getContext('2d'); inkCtx.scale(scale, scale);
  for (const stroke of state.strokes) renderStroke(inkCtx, stroke, width, height);
  const imageCtx = image.getContext('2d');
  imageCtx.fillStyle = '#ffffff'; imageCtx.fillRect(0, 0, image.width, image.height);
  imageCtx.drawImage(ink, 0, 0);
  return image;
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

$('#captureButton').addEventListener('click', async () => {
  finishStroke();
  if (!state.strokes.length) { toast('Write something on the board first'); return; }
  const button = $('#captureButton'); button.disabled = true;
  $('#notesFeedback').textContent = 'Loading handwriting recognition…';
  let worker;
  try {
    const Tesseract = await loadTesseract();
    worker = await Tesseract.createWorker('eng', 1, { logger: message => {
      if (message.status === 'recognizing text') $('#notesFeedback').textContent = `Reading ink… ${Math.round((message.progress || 0) * 100)}%`;
    }});
    const result = await worker.recognize(makeImageCanvas(3));
    const recognized = result.data.text.trim();
    if (!recognized) { $('#notesFeedback').textContent = 'No writing found. Try larger, darker letters.'; return; }
    state.notes.unshift({ id: crypto.randomUUID(), created: Date.now(), text: recognized });
    saveNotes(); renderNotes();
    $('#notesFeedback').textContent = 'Note captured. You can edit the text below.';
    toast('Writing recognized');
  } catch (error) {
    console.error(error); $('#notesFeedback').textContent = 'Recognition could not load. Check your connection and try again.';
  } finally {
    if (worker) await worker.terminate();
    button.disabled = false;
  }
});

function setMode(mode) {
  if (state.mode === mode) return;
  finishStroke(); state.pinchGate.reset(); state.pointFilter.reset(); state.offhandGesture.reset(); state.pendingCameraStart = null;
  state.mode = mode; state.cameraId = '';
  document.querySelectorAll('[data-mode]').forEach(button => button.classList.toggle('is-active', button.dataset.mode === mode));
  $('#cameraBox').classList.toggle('mirrored', mode === 'computer');
  $('#modeDescription').textContent = mode === 'iphone'
    ? 'Point your iPhone at your hands or desk. On a Mac, connect it with Continuity Camera first.'
    : 'Face your computer camera. Touch thumb and index tips to draw; separate them to stop immediately.';
  $('#gestureHint').textContent = 'Touch fingertips to draw · separate to stop';
  updateCameraList();
  if (state.running) restartCamera();
}
document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => setMode(button.dataset.mode)));
$('#pencilToggle').addEventListener('change', event => { state.pencil = event.target.checked; toast(state.pencil ? 'Pencil marker tracking on' : 'Pencil marker tracking off'); });
$('#cameraSelect').addEventListener('change', event => { state.cameraId = event.target.value; if (state.running) restartCamera(); });

const isOnIPhone = /iPhone|iPad|iPod/i.test(navigator.userAgent);

async function updateCameraList() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'videoinput');
    const select = $('#cameraSelect');
    const defaultLabel = state.mode === 'iphone' ? (isOnIPhone ? 'iPhone rear camera' : 'Auto-detect iPhone') : 'Default computer camera';
    select.replaceChildren(new Option(defaultLabel, ''));
    const matching = devices.filter(device => state.mode === 'iphone' ? isIPhoneCamera(device) : !isIPhoneCamera(device));
    matching.forEach((device, index) => select.add(new Option(device.label || `Camera ${index + 1}`, device.deviceId)));
    select.value = matching.some(device => device.deviceId === state.cameraId) ? state.cameraId : '';
  } catch { /* Device labels may remain hidden until permission is granted. */ }
}

async function loadLandmarker() {
  if (state.landmarker) return state.landmarker;
  const { FilesetResolver, HandLandmarker } = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/+esm');
  const vision = await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm');
  state.landmarker = await HandLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task', delegate: 'GPU' },
    runningMode: 'VIDEO', numHands: 2, minHandDetectionConfidence: .55, minHandPresenceConfidence: .55, minTrackingConfidence: .55
  }).catch(async () => HandLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task', delegate: 'CPU' },
    runningMode: 'VIDEO', numHands: 2
  }));
  return state.landmarker;
}

async function startCamera() {
  const token = ++state.cameraToken;
  if (!navigator.mediaDevices?.getUserMedia) { setStatus('Camera unavailable', 'error'); toast('Use HTTPS or localhost for camera access'); return; }
  $('#cameraButtonText').textContent = 'Starting…'; $('#cameraButton').disabled = true;
  setStatus('Starting camera');
  try {
    let devices = await navigator.mediaDevices.enumerateDevices();
    let selected = pickCameraDevice(devices, state.mode, state.cameraId);
    if (state.mode === 'iphone' && !isOnIPhone && !selected) {
      // Camera labels can be hidden until the browser has camera permission.
      const permissionStream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
      permissionStream.getTracks().forEach(track => track.stop());
      if (token !== state.cameraToken) return;
      devices = await navigator.mediaDevices.enumerateDevices();
      selected = pickCameraDevice(devices, state.mode, state.cameraId);
      if (!selected) throw Object.assign(new Error('iPhone camera unavailable'), { name: 'IPhoneCameraNotFound' });
    }
    const constraints = selected?.deviceId
      ? { deviceId: { exact: selected.deviceId } }
      : { facingMode: state.mode === 'iphone' ? 'environment' : 'user' };
    const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { ...constraints, width: { ideal: 960 }, height: { ideal: 540 }, frameRate: { ideal: 30 } } });
    if (token !== state.cameraToken) { stream.getTracks().forEach(track => track.stop()); return; }
    state.stream = stream;
    const activeLabel = stream.getVideoTracks()[0]?.label || '';
    if (state.mode === 'iphone' && !isOnIPhone && !isIPhoneCamera({ label: activeLabel }))
      throw Object.assign(new Error('Selected camera is not an iPhone'), { name: 'IPhoneCameraNotFound' });
    if (state.mode === 'computer' && isIPhoneCamera({ label: activeLabel }))
      throw Object.assign(new Error('Selected camera is an iPhone'), { name: 'ComputerCameraNotFound' });
    video.srcObject = stream;
    await video.play(); await updateCameraList();
    setStatus('Loading hand tracking');
    await loadLandmarker();
    if (token !== state.cameraToken) return;
    state.running = true; state.lastVideoTime = -1;
    $('#cameraBox').classList.add('active');
    $('#cameraBox').classList.toggle('mirrored', state.mode === 'computer');
    $('#cameraButtonText').textContent = 'Stop camera'; $('#cameraButton').disabled = false;
    setStatus('Looking for hands', 'live');
    processFrame();
  } catch (error) {
    console.error(error); stopCamera();
    const iphoneMissing = error.name === 'IPhoneCameraNotFound';
    const computerMissing = error.name === 'ComputerCameraNotFound';
    setStatus(iphoneMissing ? 'iPhone camera not found' : computerMissing ? 'Computer camera not found' : error.name === 'NotAllowedError' ? 'Camera permission denied' : 'Camera could not start', 'error');
    toast(iphoneMissing ? 'Connect your iPhone with Continuity Camera, then try again' : computerMissing ? 'Choose a computer camera in Camera source' : error.name === 'NotAllowedError' ? 'Allow camera access and try again' : 'Check the camera and your connection');
  }
}

function stopCamera() {
  state.cameraToken++;
  state.running = false; cancelAnimationFrame(state.frameId); finishStroke();
  state.pinchGate.reset(); state.pointFilter.reset(); state.offhandGesture.reset(); state.pendingCameraStart = null; state.lastHandSeenAt = 0; state.dominantWrist = null;
  state.stream?.getTracks().forEach(track => track.stop()); state.stream = null;
  video.srcObject = null; overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
  cursor.style.display = 'none'; $('#cameraBox').classList.remove('active');
  $('#cameraButtonText').textContent = 'Start camera'; $('#cameraButton').disabled = false;
  setStatus('Camera off');
}

function restartCamera() { stopCamera(); startCamera(); }
$('#cameraButton').addEventListener('click', () => state.running ? stopCamera() : startCamera());

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function chooseHands(hands) {
  const index = pickDrawingHandIndex(hands, state.dominantWrist);
  if (index < 0) return [null, null];
  state.dominantWrist = hands[index][0];
  return [hands[index], hands.length === 2 ? hands[1-index] : null];
}

const markerCanvas = document.createElement('canvas'); markerCanvas.width = 160; markerCanvas.height = 90;
const markerCtx = markerCanvas.getContext('2d', { willReadFrequently: true });
function scanMarkers(hand) {
  if (!state.pencil) return null;
  markerCtx.drawImage(video, 0, 0, markerCanvas.width, markerCanvas.height);
  const pixels = markerCtx.getImageData(0, 0, markerCanvas.width, markerCanvas.height).data;
  const found = { tip: {x:0,y:0,n:0}, eraser: {x:0,y:0,n:0} };
  for (let y=0; y<90; y+=2) for (let x=0; x<160; x+=2) {
    const i=(y*160+x)*4, r=pixels[i], g=pixels[i+1], b=pixels[i+2];
    const nx=x/160, ny=y/90;
    if (Math.hypot(nx-hand[8].x, ny-hand[8].y)>.28) continue;
    const kind = b>95 && g>115 && g>r*1.25 && b>r*1.3 ? 'tip' : r>145 && r>g*1.26 && b>g*.75 && b>65 ? 'eraser' : null;
    if (kind) { found[kind].x+=nx; found[kind].y+=ny; found[kind].n++; }
  }
  const kind = found.eraser.n>12 ? 'eraser' : found.tip.n>12 ? 'tip' : null;
  return kind ? { kind, x:found[kind].x/found[kind].n, y:found[kind].y/found[kind].n } : null;
}

function mapToBoard(point) {
  const x = state.mode === 'computer' ? 1-point.x : point.x;
  return { x: Math.max(0, Math.min(1, (x-.06)/.88)), y: Math.max(0, Math.min(1, (point.y-.06)/.88)) };
}

function handleOffhand(hand, now) {
  const gesture = state.offhandGesture.update(hand, now);
  if (gesture.action === 'undo') {
    state.lastGestureAt = now; undo(); toast('Undid last stroke');
  } else if (gesture.action === 'color') {
    const next = (colors.indexOf(state.color) + 1) % colors.length;
    state.lastGestureAt = now; setColor(colors[next]); toast('Color changed');
  }
  return gesture;
}

function handleWave(dominant, offhand, now) {
  if (!offhand) { state.wavePoints = []; return; }
  const last = state.wavePoints.at(-1);
  if (!last || now - last.t > 80) state.wavePoints.push({ t: now, a: dominant[0].x, b: offhand[0].x });
  state.wavePoints = state.wavePoints.filter(point => now - point.t < 750);
  if (state.wavePoints.length < 5 || now - state.lastGestureAt < 3500 || $('#clearDialog').open) return;
  const first = state.wavePoints[0];
  const aRange = Math.max(...state.wavePoints.map(p => p.a)) - Math.min(...state.wavePoints.map(p => p.a));
  const bRange = Math.max(...state.wavePoints.map(p => p.b)) - Math.min(...state.wavePoints.map(p => p.b));
  const aMoved = Math.abs(dominant[0].x - first.a) > .17;
  const bMoved = Math.abs(offhand[0].x - first.b) > .17;
  if (aRange > .22 && bRange > .22 && aMoved && bMoved && state.strokes.length) {
    state.wavePoints = []; state.lastGestureAt = now; finishStroke(); $('#clearDialog').showModal();
  }
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
    const result=state.landmarker.detectForVideo(video, performance.now());
    const hands=result.landmarks || [];
    drawLandmarks(hands);
    const previousWrist=state.dominantWrist;
    const [dominant, offhand]=chooseHands(hands);
    if (!dominant) {
      finishStroke(); state.pendingCameraStart=null; state.pinchGate.reset(); state.pointFilter.reset(); state.offhandGesture.reset(); state.dominantWrist=null;
      cursor.style.display='none';setStatus('Looking for hands','live');return;
    }
    const now=performance.now();
    if (previousWrist && distance(previousWrist,dominant[0])>.22) {
      finishStroke(); state.pendingCameraStart=null; state.pinchGate.reset(); state.pointFilter.reset();
    }
    state.lastHandSeenAt=now;
    handleWave(dominant,offhand,now);
    const offhandGesture=handleOffhand(offhand,now);
    const marker=scanMarkers(dominant);
    const point=state.pointFilter.update(mapToBoard(marker || dominant[8]),now,mapToBoard(dominant[0]));
    if (state.pointFilter.discontinuity) { finishStroke(); state.pendingCameraStart=null; }
    const rect=canvas.getBoundingClientRect();
    cursor.style.display='block'; cursor.style.left=`${point.x*rect.width}px`; cursor.style.top=`${point.y*rect.height}px`;
    const drawing=state.pinchGate.update(pinchRatio(dominant)) && !offhandGesture.pause && !$('#clearDialog').open;
    const tool=marker?.kind==='eraser' ? 'eraser' : marker?.kind==='tip' ? 'pen' : state.tool;
    cursor.classList.toggle('drawing',drawing);cursor.classList.toggle('eraser',tool==='eraser');
    if (drawing) {
      if (state.current?.tool!==tool) finishStroke();
      if (state.current) continueStroke(point);
      else if (!state.pendingCameraStart) state.pendingCameraStart=point;
      else if (distance(point,state.pendingCameraStart)>.006) {
        beginStroke(state.pendingCameraStart,tool); continueStroke(point); state.pendingCameraStart=null;
      }
    } else { finishStroke(); state.pendingCameraStart=null; }
    const gestureHint=offhandGesture.pose==='point' ? ' · Hold pointer to change color' : offhandGesture.pose==='fist' ? ' · Hold fist to undo' : '';
    setStatus((offhandGesture.pause ? 'Paused by open palm' : drawing ? (tool==='eraser' ? 'Eraser on — move to erase' : 'Pen on — move to draw') : 'Pen off — touch fingertips to draw') + gestureHint,'live');
  } catch (error) { console.error(error); stopCamera(); setStatus('Tracking stopped','error'); toast('Hand tracking stopped. Try restarting the camera.'); }
}

loadSaved(); renderNotes();
let initialTheme = 'light';
try { initialTheme = localStorage.getItem(THEME_KEY) || 'light'; } catch { /* Use the default theme. */ }
setTheme(initialTheme);
initializeCloud();
new ResizeObserver(resizeBoard).observe($('#boardWrap'));
updateCameraList();
