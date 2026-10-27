import * as THREE from "three";

// student ID 241418
const VARIANT = {
  studentId: "241418",
  product: "Floor speaker",
  maxProducts: 1,
  tiltToleranceDeg: 12,
  faceUser: false,
};

const SPACE = new URLSearchParams(location.search).get("space") === "local-floor" ? "local-floor" : "local";
const ANCHORS_ALLOWED = new URLSearchParams(location.search).get("anchors") !== "off";
const GREEN = 0x00e676;
const RED = 0xff3b30;

let btn, gl, glCanvas, camera, scene, renderer, controller, reticle, productTemplate;
let overlay, panel, statusEl, warningEl, logEl, fallbackEl;

let xrSession = null, hitTestSource = null, hitTestSourceRequested = false;
let localSpace = null, viewerSpace = null;
let anchorsOn = false;
let placeRequested = false;
let logRequested = false;
let trackingLost = false;
let sessionState = "not started";
let reticleState = "none";
const placed = [];

let sessionStartTime = 0, startPoseLogged = false, firstHitLogged = false;
const logLines = [];
let lastStatus = "";

const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _one = new THREE.Vector3(1, 1, 1);
const _up = new THREE.Vector3(0, 1, 0);

loadScene();

function loadScene() {
  overlay = document.getElementById("overlay");
  panel = document.getElementById("panel");
  statusEl = document.getElementById("status");
  warningEl = document.getElementById("warning");
  logEl = document.getElementById("log");
  fallbackEl = document.getElementById("fallback");
  btn = document.getElementById("arbtn");

  // newer three.js needs a WebGL2 context
  glCanvas = document.createElement("canvas");
  gl = glCanvas.getContext("webgl2", { alpha: true, antialias: true, xrCompatible: true });
  if (!gl) {
    showFallback("WebGL 2 is not available in this browser, so the AR view cannot be drawn.");
    return;
  }

  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 20);
  scene = new THREE.Scene();

  scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.2));
  const sun = new THREE.DirectionalLight(0xffffff, 2.0);
  sun.position.set(1, 3, 2);
  scene.add(sun);

  renderer = new THREE.WebGLRenderer({ canvas: glCanvas, context: gl, alpha: true, antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;
  Object.assign(renderer.domElement.style, { position: "fixed", top: "0", left: "0", zIndex: "-1", pointerEvents: "none" });
  document.body.appendChild(renderer.domElement);
  window.addEventListener("resize", () => {
    if (renderer.xr.isPresenting) return;
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  reticle = new THREE.Mesh(
    new THREE.RingGeometry(0.12, 0.16, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: GREEN, side: THREE.DoubleSide })
  );
  reticle.matrixAutoUpdate = false;
  reticle.visible = false;
  scene.add(reticle);

  productTemplate = buildProduct();
  checkProductSize();

  controller = renderer.xr.getController(0);
  controller.addEventListener("select", () => { placeRequested = true; });
  scene.add(controller);

  // taps on the panel shouldn't place anything
  panel.addEventListener("beforexrselect", (e) => e.preventDefault());
  document.getElementById("clear").addEventListener("click", clearPlaced);
  document.getElementById("logbtn").addEventListener("click", () => { logRequested = true; });

  updateOverlay();

  if (!navigator.xr) {
    showFallback("WebXR is not available here. Open this page in Chrome on an ARCore Android phone (or the Quest 3 browser) over HTTPS or localhost.");
    return;
  }
  navigator.xr.isSessionSupported("immersive-ar").then((supported) => {
    if (!supported) {
      showFallback("This device or browser does not support immersive-ar WebXR sessions (iPhone/iPad Safari does not). Use an ARCore Android phone with Chrome.");
      return;
    }
    btn.hidden = false;
    btn.addEventListener("click", () => (xrSession ? endXRSession() : onRequestSession()));
  }).catch((err) => showFallback("Could not check AR support: " + err.message));
}

// 0.25 x 1.00 x 0.30 m, origin at the centre of the base, front faces +z
function buildProduct() {
  const W = 0.25, H = 1.0, D = 0.30, POP = 0.005;
  const group = new THREE.Group();
  group.name = "floor-speaker";

  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x464a54, roughness: 0.6, metalness: 0.1 });
  const coneMat = new THREE.MeshStandardMaterial({ color: 0x111113, roughness: 0.9 });
  const capMat = new THREE.MeshStandardMaterial({ color: 0xaab0b8, roughness: 0.3, metalness: 0.8 });

  const cabinet = new THREE.Mesh(new THREE.BoxGeometry(W, H, D - POP), bodyMat);
  cabinet.position.set(0, H / 2, -POP / 2);
  group.add(cabinet);

  const frontZ = D / 2 - POP;
  const disc = (radius, stand, material, y) => {
    const t = 0.010;
    const m = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, t, 40).rotateX(Math.PI / 2), material);
    m.position.set(0, y, frontZ + stand - t / 2);
    return m;
  };
  group.add(disc(0.09, POP, coneMat, 0.35));
  group.add(disc(0.03, POP, coneMat, 0.78));
  group.add(disc(0.03, POP + 0.0005, capMat, 0.35));
  return group;
}

function checkProductSize() {
  const box = new THREE.Box3().setFromObject(productTemplate);
  const size = box.getSize(new THREE.Vector3());
  log(`product size W x H x D = ${size.x.toFixed(3)} x ${size.y.toFixed(3)} x ${size.z.toFixed(3)} m; box.min.y = ${box.min.y.toFixed(3)}`);
  return size;
}

async function onRequestSession() {
  btn.disabled = true;
  sessionState = "starting...";
  updateOverlay();
  try {
    const session = await navigator.xr.requestSession("immersive-ar", {
      requiredFeatures: ["hit-test"],
      optionalFeatures: SPACE === "local" ? ["anchors", "dom-overlay"] : ["anchors", "dom-overlay", "local-floor"],
      domOverlay: { root: overlay },
    });
    await onSessionStarted(session);
  } catch (err) {
    console.error("Could not start the AR session:", err);
    if (xrSession) xrSession.end().catch(() => {});
    sessionState = "not started";
    btn.disabled = false;
    showFallback("Could not start AR: " + err.message);
  }
}

async function onSessionStarted(session) {
  xrSession = session;
  session.addEventListener("end", onSessionEnd);

  btn.textContent = "STOP AR";
  btn.disabled = false;
  anchorsOn = ANCHORS_ALLOWED && Array.from(session.enabledFeatures || []).includes("anchors");
  sessionStartTime = performance.now();
  startPoseLogged = false;
  firstHitLogged = false;
  placeRequested = false;
  logRequested = false;

  renderer.xr.setReferenceSpaceType(SPACE);
  await renderer.xr.setSession(session);
  if (xrSession !== session) return;

  localSpace = renderer.xr.getReferenceSpace();
  sessionState = "running";
  animate();
}

function animate() {
  renderer.setAnimationLoop(render);
}

function render(time, frame) {
  if (frame && localSpace) {
    const viewerPose = frame.getViewerPose(localSpace);
    trackingLost = !viewerPose || viewerPose.emulatedPosition;

    if (!hitTestSourceRequested) requestHitTestSourceOnce(frame.session);

    let hit = null, hitPose = null, tilt = 0, valid = false;
    if (hitTestSource) {
      const results = frame.getHitTestResults(hitTestSource);
      if (results.length > 0) {
        hit = results[0];
        hitPose = hit.getPose(localSpace);
      }
    }

    if (hitPose) {
      const m = hitPose.transform.matrix;
      reticle.matrix.fromArray(m);
      reticle.visible = true;
      tilt = tiltFromUp(m);
      valid = tilt <= VARIANT.tiltToleranceDeg;
      reticle.material.color.setHex(valid ? GREEN : RED);
      reticleState = valid ? `valid (${tilt.toFixed(1)}°)` : `too tilted (${tilt.toFixed(1)}°)`;
      if (!firstHitLogged) {
        firstHitLogged = true;
        log(`E4: first hit after ${((time - sessionStartTime) / 1000).toFixed(1)} s`);
      }
    } else {
      reticle.visible = false;
      reticleState = "none";
    }

    const wantPlace = placeRequested;
    placeRequested = false;
    if (wantPlace && valid && !trackingLost) placeProduct(hit, viewerPose);

    updatePlacedPoses(frame);

    if (viewerPose && !startPoseLogged) {
      startPoseLogged = true;
      logCamera(`E1 session start (${SPACE})`, viewerPose);
    }
    if (logRequested) {
      logRequested = false;
      logPoses(hit, hitPose, viewerPose, tilt);
    }
  }
  updateOverlay();
  renderer.render(scene, camera);
}

function requestHitTestSourceOnce(session) {
  hitTestSourceRequested = true;
  session.requestReferenceSpace("viewer")
    .then((space) => {
      viewerSpace = space;
      return session.requestHitTestSource({ space });
    })
    .then((source) => {
      if (xrSession !== session) { source.cancel(); return; }
      hitTestSource = source;
    })
    .catch((err) => console.error("hit-test source failed:", err));
}

// angle between the surface normal (y column of the pose matrix) and world up
function tiltFromUp(m) {
  const len = Math.hypot(m[4], m[5], m[6]);
  const cos = THREE.MathUtils.clamp(m[5] / len, -1, 1);
  return THREE.MathUtils.radToDeg(Math.acos(cos));
}

function placeProduct(hit, viewerPose) {
  while (placed.length >= VARIANT.maxProducts) removeProduct(placed.shift());

  const entry = { object: productTemplate.clone(), anchor: null, yaw: 0, removed: false };
  entry.object.matrixAutoUpdate = false;

  if (VARIANT.faceUser) {
    const cam = viewerPose.transform.position;
    entry.yaw = Math.atan2(cam.x - reticle.matrix.elements[12], cam.z - reticle.matrix.elements[14]);
  }

  setProductMatrix(entry, reticle.matrix.elements);
  scene.add(entry.object);
  placed.push(entry);

  if (anchorsOn) {
    hit.createAnchor()
      .then((anchor) => {
        if (entry.removed) anchor.delete();
        else entry.anchor = anchor;
      })
      .catch((err) => log("anchor creation failed: " + err.message));
  }
}

function updatePlacedPoses(frame) {
  for (const entry of placed) {
    if (!entry.anchor) continue;
    const pose = frame.getPose(entry.anchor.anchorSpace, localSpace);
    if (pose) setProductMatrix(entry, pose.transform.matrix);
  }
}

function setProductMatrix(entry, poseMatrix) {
  const m = entry.object.matrix.fromArray(poseMatrix);
  if (VARIANT.faceUser) {
    m.compose(_pos.setFromMatrixPosition(m), _quat.setFromAxisAngle(_up, entry.yaw), _one);
  }
  entry.object.matrixWorldNeedsUpdate = true;
}

function removeProduct(entry) {
  entry.removed = true;
  scene.remove(entry.object);
  if (entry.anchor) {
    try { entry.anchor.delete(); } catch (e) { }
    entry.anchor = null;
  }
}

function clearPlaced() {
  while (placed.length) removeProduct(placed.pop());
}

function endXRSession() {
  if (xrSession) xrSession.end().catch((err) => console.warn("end() failed:", err));
}

function onSessionEnd() {
  if (hitTestSource) {
    try { hitTestSource.cancel(); } catch (e) { }
  }
  hitTestSource = null;
  hitTestSourceRequested = false;
  viewerSpace = null;
  localSpace = null;
  clearPlaced();
  placeRequested = false;
  logRequested = false;
  trackingLost = false;
  reticle.visible = false;
  reticleState = "none";
  renderer.setAnimationLoop(null);
  xrSession = null;
  anchorsOn = false;
  sessionState = "ended";
  btn.textContent = "START AR";
  btn.disabled = false;
  updateOverlay();
}

function updateOverlay() {
  const lines = [
    `${VARIANT.studentId} · ${VARIANT.product} · ${VARIANT.maxProducts === 1 ? "single" : "multi"} · ${VARIANT.tiltToleranceDeg}° · ${VARIANT.faceUser ? "faces user" : "keeps hit orientation"}`,
    `Session: ${sessionState}`,
    `Reticle: ${reticleState}`,
    `Anchors: ${anchorsOn ? "on" : "off"}`,
    `Products: ${placed.length}/${VARIANT.maxProducts}`,
  ].join("\n");
  if (lines !== lastStatus) {
    lastStatus = lines;
    statusEl.textContent = lines;
  }
  warningEl.textContent = xrSession && trackingLost ? "Tracking lost, move the phone slowly" : "";
}

function showFallback(message) {
  fallbackEl.textContent = message;
  fallbackEl.hidden = false;
  console.warn(message);
}

function log(text) {
  console.log(text);
  logLines.push(text);
  if (logLines.length > 8) logLines.shift();
  logEl.textContent = logLines.join("\n");
}

const f3 = (v) => v.toFixed(3);

function logCamera(label, viewerPose) {
  const p = viewerPose.transform.position;
  log(`${label}: camera in local = (${f3(p.x)}, ${f3(p.y)}, ${f3(p.z)})`);
}

function logPoses(hit, hitPose, viewerPose, tilt) {
  if (viewerPose) logCamera("E1 now", viewerPose);
  if (!hit || !hitPose) { log("no hit to log"); return; }
  const inViewer = hit.getPose(viewerSpace);
  const pv = inViewer && inViewer.transform.position, pl = hitPose.transform.position;
  if (pv) log(`E1 hit in viewer = (${f3(pv.x)}, ${f3(pv.y)}, ${f3(pv.z)})`);
  log(`E1 hit in local  = (${f3(pl.x)}, ${f3(pl.y)}, ${f3(pl.z)})`);
  const m = hitPose.transform.matrix;
  for (let c = 0; c < 4; c++) {
    const tag = c === 1 ? " <- surface normal" : c === 3 ? " <- position" : "";
    log(`E3 m[${c * 4}..${c * 4 + 3}] = ${[m[c * 4], m[c * 4 + 1], m[c * 4 + 2], m[c * 4 + 3]].map(f3).join(", ")}${tag}`);
  }
  log(`E3 tilt = acos(${f3(m[5])}) = ${tilt.toFixed(2)}°`);
}
