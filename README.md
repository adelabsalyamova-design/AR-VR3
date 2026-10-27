# PA3: AR product preview with hit-testing (241418)

A WebXR immersive-ar page written with Three.js 0.186.1, loaded through an import map. There is no ARButton and no model file. You point the phone at the floor, wait for the ring, tap, and a floor speaker appears on the surface at real size.

## Variant

Student ID 241418, last four digits read from the right: 8, 1, 4, 1.

- Product (last digit, 8): floor speaker, 0.25 m wide, 0.30 m deep, 1.00 m high, two driver discs on the front.
- Placement mode (second digit from the end, 1 mod 2 = 1): single. There is one product and every tap moves it.
- Surface tolerance (third digit from the end, 4 mod 3 = 1): 12 degrees from straight up.
- Facing (fourth digit from the end, 1 mod 2 = 1): the product keeps the orientation of the hit pose.

All four values are in the VARIANT object at the top of index.js.

## Device

- Phone: [FILL: model, Android version]
- Chrome: [FILL: version from chrome://version]
- Google Play Services for AR: [FILL, optional]

## Running it

GitHub Pages: enable Pages for the main branch (root) and open https://<user>.github.io/<repo>/ in Chrome on the phone. Three.js comes from the import map in index.html (https://cdn.jsdelivr.net/npm/three@0.186.1/build/three.module.js).

localhost over ADB:

```bash
npx http-server -p 8080          # in the project folder
adb reverse tcp:8080 tcp:8080    # USB debugging must be on
# on the phone, in Chrome: http://localhost:8080
# page console: chrome://inspect on the desktop
```

To run without internet, install three with `npm i three@0.186.1` and change the import map entry to "three": "./node_modules/three/build/three.module.js".

## Using it

Press START AR and move the phone slowly over the floor until the ring shows up. A green ring means the surface is accepted. A red ring means it is tilted more than 12 degrees and a tap does nothing. Tap to place the speaker, tap somewhere else to move it. Clear removes the speaker. STOP AR (or the system back gesture) ends the session. Log prints the numbers I used in the write-up.

To keep the page smooth on a phone, antialiasing is off, the XR framebuffer scale is 0.8 (RENDER_SCALE in index.js) and the panel text refreshes four times a second.

## Where things are in index.js

- A, session life cycle and fallback: loadScene(), onRequestSession(), onSessionStarted(), endXRSession(), onSessionEnd()
- B, hit test, reticle and tilt filter: requestHitTestSourceOnce(), render(), tiltFromUp()
- C, product: buildProduct(), checkProductSize() (logs the Box3 size)
- D, placement and anchors: placeProduct(), updatePlacedPoses(), setProductMatrix(), removeProduct()
- E, overlay and robustness: updateOverlay(), the beforexrselect listener on #panel, trackingLost in render()

Easy one-line changes are tiltToleranceDeg, maxProducts (1 is single, 5 is multi) and faceUser in VARIANT.

Two URL parameters exist only for the write-up. ?space=local-floor asks for the local-floor reference space instead of local (E2b). ?anchors=off turns anchors off (E2a). The Log button prints the camera position, the same hit in viewer and local space and the 16 matrix values. After each session start the log also shows how many seconds it took to get the first hit.

## Porting notes (Ch. 7 listings to Three.js 0.186.1)

1. new WebGLRenderer() throws. The Ch. 7 code makes a "webgl" context and passes it to the renderer. Since r163 Three.js only supports WebGL 2, and src/renderers/WebGLRenderer.js throws "WebGL 1 is not supported since r163" (line 102). Fix: glCanvas.getContext("webgl2", { alpha: true, antialias: false, xrCompatible: true }). xrCompatible: true keeps the context usable for the XR session.

2. RingBufferGeometry, BoxBufferGeometry and CylinderBufferGeometry are undefined. The BufferGeometry names are gone in r186, so calling them as constructors gives a TypeError. Fix: use RingGeometry, BoxGeometry and CylinderGeometry, which are the same classes under the current names.

3. The hit-test source is requested on every frame. TODO: check this against the Ch. 7 listing and quote the exact guard line here. The Ch. 7 render loop decides whether to request a source with a flag that is not set before the next frame arrives, so requestHitTestSource() is called again and again while the first promise is still pending. Fix: requestHitTestSourceOnce() sets hitTestSourceRequested = true before the async call and stores the source when the promise resolves (and cancels it right away if the session has already ended). onSessionEnd() cancels the source and resets the flag, so the next session requests exactly one.
