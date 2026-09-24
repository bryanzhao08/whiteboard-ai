import { PinchGate, isIPhoneCamera, pickCameraDevice } from './tracking.mjs';

const $ = (selector) => document.querySelector(selector);
const canvas = $('#board');
const ctx = canvas.getContext('2d');
const video = $('#cameraVideo');
const overlay = $('#cameraOverlay');
const overlayCtx = overlay.getContext('2d');
const cursor = $('#handCursor');
const STORAGE_KEY = 'mirrorboard-v1';
const NOTES_KEY = 'mirrorboard-notes-v1';
const colors = ['#172a33', '#e87355', '#5287ab', '#7b9871'];
const state = {
  strokes: [], redo: [], notes: [], current: null, tool: 'pen', color: colors[0], size: 5,
  mode: 'computer', stream: null, landmarker: null, running: false, frameId: 0,
  lastVideoTime: -1, dominantWrist: null, lastHandSeenAt: 0,
  pinchGate: new PinchGate(), pendingCameraStart: null,
  offhandWasFist: false, offhandPointStart: 0, lastGestureAt: 0,
  wavePoints: [], cameraId: '', pencil: false, cameraToken: 0
};

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

function markSaved() {
  $('#saveState').textContent = 'Saved locally';
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.strokes)); }
  catch { $('#saveState').textContent = 'Storage full'; }
}

function loadSaved() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    if (Array.isArray(saved)) state.strokes = saved.filter(s => s && Array.isArray(s.points) && ['pen', 'eraser'].includes(s.tool));
    const notes = JSON.parse(localStorage.getItem(NOTES_KEY) || '[]');
    if (Array.isArray(notes)) state.notes = notes.filter(n => n && typeof n.text === 'string');
  } catch { /* Start with an empty board when stored data is invalid. */ }
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
  target.strokeStyle = stroke.color;
  target.fillStyle = stroke.color;
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
  $('#emptyState').classList.toggle('hidden', state.strokes.length > 0 || !!state.current);
  $('#strokeCount').textContent = state.strokes.length;
  $('#undoButton').disabled = state.strokes.length === 0;
  $('#redoButton').disabled = state.redo.length === 0;
}

function beginStroke(point, tool = state.tool) {
  if (state.current) finishStroke();
  state.current = { tool, color: state.color, size: state.size, points: [point] };
  redraw();
}

function continueStroke(point) {
  if (!state.current) return;
  const last = state.current.points.at(-1);
  if (Math.hypot(point.x - last.x, point.y - last.y) < .0015) return;
  state.current.points.push(point);
  redraw();
}

function finishStroke() {
  if (!state.current) return;
  state.strokes.push(state.current);
  state.current = null;
  state.redo = [];
  redraw();
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

$('#exportButton').addEventListener('click', () => {
  finishStroke();
  const link = document.createElement('a');
  link.href = makeImageCanvas().toDataURL('image/png');
  link.download = `mirrorboard-${new Date().toISOString().slice(0, 10)}.png`;
  link.click(); toast('PNG exported');
});

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
  try { localStorage.setItem(NOTES_KEY, JSON.stringify(state.notes)); }
  catch { toast('Unable to save more notes on this device'); }
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
  finishStroke(); state.pinchGate.reset(); state.pendingCameraStart = null;
  state.mode = mode; state.cameraId = '';
  document.querySelectorAll('[data-mode]').forEach(button => button.classList.toggle('is-active', button.dataset.mode === mode));
  $('#cameraBox').classList.toggle('mirrored', mode === 'computer');
  $('#modeDescription').textContent = mode === 'iphone'
    ? 'Point your iPhone at your hands or desk. On a Mac, connect it with Continuity Camera first.'
    : 'Face your computer camera. Pinch and keep your fingers together while moving to draw.';
  $('#gestureHint').textContent = 'Pinch and hold to draw · release to stop';
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
    const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { ...constraints, width: { ideal: 1280 }, height: { ideal: 720 } } });
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
  state.pinchGate.reset(); state.pendingCameraStart = null; state.lastHandSeenAt = 0;
  state.stream?.getTracks().forEach(track => track.stop()); state.stream = null;
  video.srcObject = null; overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
  cursor.style.display = 'none'; $('#cameraBox').classList.remove('active');
  $('#cameraButtonText').textContent = 'Start camera'; $('#cameraButton').disabled = false;
  setStatus('Camera off');
}

function restartCamera() { stopCamera(); startCamera(); }
$('#cameraButton').addEventListener('click', () => state.running ? stopCamera() : startCamera());

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const isExtended = (hand, tip, pip) => distance(hand[tip], hand[0]) > distance(hand[pip], hand[0]) * 1.1;
function fingerCount(hand) { return [[8,6],[12,10],[16,14],[20,18]].filter(([tip,pip]) => isExtended(hand,tip,pip)).length; }
function pinchRatio(hand) {
  const palmWidth = distance(hand[5], hand[17]);
  return distance(hand[4], hand[8]) / Math.max(palmWidth, .001);
}

function chooseHands(hands) {
  if (!hands.length) return [null, null];
  if (hands.length === 1) { state.dominantWrist = hands[0][0]; return [hands[0], null]; }
  let index = 0;
  if (state.dominantWrist) index = distance(hands[1][0], state.dominantWrist) < distance(hands[0][0], state.dominantWrist) ? 1 : 0;
  else index = hands[0][0].x > hands[1][0].x ? 0 : 1;
  state.dominantWrist = hands[index][0];
  return [hands[index], hands[1-index]];
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
  if (!hand) { state.offhandWasFist = false; state.offhandPointStart = 0; return false; }
  const count = fingerCount(hand), palm = count >= 4, fist = count <= 1;
  if (fist) state.offhandWasFist = true;
  if (palm && state.offhandWasFist && now-state.lastGestureAt>1200) {
    state.offhandWasFist = false; state.lastGestureAt = now; undo(); toast('Undid last stroke');
  }
  const pointing = isExtended(hand,8,6) && !isExtended(hand,12,10) && !isExtended(hand,16,14) && !isExtended(hand,20,18);
  if (pointing) {
    if (!state.offhandPointStart) state.offhandPointStart = now;
    if (now-state.offhandPointStart > 1000 && now-state.lastGestureAt>1200) {
      const next = (colors.indexOf(state.color)+1)%colors.length;
      setColor(colors[next]); state.lastGestureAt=now; state.offhandPointStart=0; toast('Color changed');
    }
  } else state.offhandPointStart=0;
  return palm;
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
    const [dominant, offhand]=chooseHands(hands);
    if (!dominant) {
      if (performance.now()-state.lastHandSeenAt > 240) {
        finishStroke(); state.pendingCameraStart=null; state.pinchGate.reset();
      }
      cursor.style.display='none';setStatus('Looking for hands','live');return;
    }
    const now=performance.now();
    state.lastHandSeenAt=now;
    handleWave(dominant,offhand,now);
    const paused=handleOffhand(offhand,now);
    const marker=scanMarkers(dominant);
    const point=mapToBoard(marker || dominant[8]);
    const rect=canvas.getBoundingClientRect();
    cursor.style.display='block'; cursor.style.left=`${point.x*rect.width}px`; cursor.style.top=`${point.y*rect.height}px`;
    const drawing=state.pinchGate.update(pinchRatio(dominant),now) && !paused && !$('#clearDialog').open;
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
    setStatus(paused ? 'Paused by open palm' : drawing ? (tool==='eraser' ? 'Eraser on — move to erase' : 'Pen on — move to draw') : 'Pen off — pinch to draw','live');
  } catch (error) { console.error(error); stopCamera(); setStatus('Tracking stopped','error'); toast('Hand tracking stopped. Try restarting the camera.'); }
}

loadSaved(); renderNotes();
new ResizeObserver(resizeBoard).observe($('#boardWrap'));
updateCameraList();
