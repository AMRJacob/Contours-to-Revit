// 3D site view (three.js): terrain draped with the aerial, cut/fill tint, index contours, design features and
// water-flow particles. Loaded on demand. Coordinates: x = east, y = up (elevation × exaggeration), z = -north,
// all in output units relative to the centre of the site box.
import * as THREE from '../lib/three/three.module.min.js';
import { OrbitControls } from '../lib/three/OrbitControls.js';

const MAX_SIDE = 360; // mesh vertices along the longer side

export class SiteView3D {
  constructor(container) {
    this.el = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x1c2226);
    container.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0x1c2226, 1e6, 2e6);
    this.camera = new THREE.PerspectiveCamera(45, 1, 1, 1e6);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    // Calm navigation: no coasting after release, slower orbit / pan / zoom, zoom toward the cursor.
    this.controls.enableDamping = false;
    this.controls.zoomToCursor = true;
    this.setSpeed(1);
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.screenSpacePanning = false;
    this.scene.add(new THREE.HemisphereLight(0xf2f5ff, 0x3b3226, 0.85));
    const sun = new THREE.DirectionalLight(0xffffff, 1.35);
    sun.position.set(-0.6, 1, 0.45);
    this.scene.add(sun);
    this.sun = sun;
    this.ex = 2;           // vertical exaggeration
    this.visible = false;
    this.flowPts = null;
    this.frames = {};      // per-frame callbacks (water flow, wind)
    this._loop = this._loop.bind(this);
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(container);
  }

  resize() {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = w + 'px';
    this.renderer.domElement.style.height = h + 'px';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  show(on) {
    this.visible = on;
    if (on) { this.resize(); if (!this._raf) this._raf = requestAnimationFrame(this._loop); }
  }

  _loop() {
    this._raf = 0;
    if (!this.visible) return;
    this.controls.update();
    for (const f of Object.values(this.frames)) f();
    this.renderer.render(this.scene, this.camera);
    this._raf = requestAnimationFrame(this._loop);
  }

  /**
   * Build or refresh the terrain.
   * opts: { g: {x0,y0,s,nx,ny}, z (Float32Array, output units), delta (Float32Array|null), box, k (output per native),
   *         image (ImageBitmap|null), cutFillScale, levelsMajor: [x1,y1,x2,y2,...] native + majorLv }
   */
  setSurface(opts) {
    const { g, z, k } = opts;
    const step = Math.max(1, Math.ceil(Math.max(g.nx, g.ny) / MAX_SIDE));
    const cols = Math.floor((g.nx - 1) / step) + 1, rows = Math.floor((g.ny - 1) / step) + 1;
    const b = opts.box;
    this.k = k; this.g = g; this.step = step;
    this.cx = (b.xmin + b.xmax) / 2; this.cy = (b.ymin + b.ymax) / 2;
    // Reference elevation: the lowest point, so the model sits on y = 0.
    let zmin = Infinity, zmax = -Infinity;
    for (const v of z) if (!Number.isNaN(v)) { if (v < zmin) zmin = v; if (v > zmax) zmax = v; }
    if (this.z0 == null || opts.resetZ) this.z0 = zmin;
    this.zmin = zmin; this.zmax = zmax;
    const n = cols * rows;
    const fresh = !this.mesh || this.mesh.userData.cols !== cols || this.mesh.userData.rows !== rows;
    let geo;
    if (fresh) {
      if (this.mesh) { this.scene.remove(this.mesh); this.mesh.geometry.dispose(); }
      geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
      geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
      const uv = new Float32Array(n * 2), idx = [];
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const i = c * step, j = r * step, x = g.x0 + i * g.s, y = g.y0 + j * g.s, q = r * cols + c;
        uv[q * 2] = (x - b.xmin) / (b.xmax - b.xmin);
        uv[q * 2 + 1] = 1 - (y - b.ymin) / (b.ymax - b.ymin);
        if (r < rows - 1 && c < cols - 1) {
          const a = q, bq = q + 1, cq = q + cols, d = q + cols + 1;
          idx.push(a, cq, bq, bq, cq, d);
        }
      }
      geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      geo.setIndex(idx);
      this.mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
      this.mesh = new THREE.Mesh(geo, this.mat);
      this.mesh.userData = { cols, rows };
      this.scene.add(this.mesh);
    } else geo = this.mesh.geometry;
    if (opts.image && this._imageSrc !== opts.image) {
      this._imageSrc = opts.image;
      const tex = new THREE.CanvasTexture(opts.image);
      tex.flipY = false;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      this.mat.map?.dispose();
      this.mat.map = tex;
      this.mat.needsUpdate = true;
    }
    const pos = geo.attributes.position.array, col = geo.attributes.color.array;
    const D = opts.delta, sc = opts.cutFillScale || 5;
    const fallback = zmin;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const i = c * step, j = r * step, gi = j * g.nx + i, q = r * cols + c;
      let zz = z[gi];
      if (Number.isNaN(zz)) zz = fallback;
      pos[q * 3] = (g.x0 + i * g.s - this.cx) * k;
      pos[q * 3 + 1] = (zz - this.z0) * this.ex;
      pos[q * 3 + 2] = -(g.y0 + j * g.s - this.cy) * k;
      let R = 1, G = 1, B = 1;
      const d = D ? D[gi] : 0;
      if (d && Math.abs(d) >= 0.05) {
        const t = Math.min(1, Math.abs(d) / sc) * 0.75;
        if (d < 0) { R = 1; G = 1 - t * 0.75; B = 1 - t * 0.75; } else { R = 1 - t * 0.7; G = 1; B = 1 - t * 0.6; }
      }
      if (!this.mat.map) { const h = (zz - zmin) / Math.max(1e-6, zmax - zmin); R *= 0.45 + h * 0.4; G *= 0.55 + h * 0.3; B *= 0.4 + h * 0.2; }
      col[q * 3] = R; col[q * 3 + 1] = G; col[q * 3 + 2] = B;
    }
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    this._contours(opts.major, opts.majorLv);
    if (fresh || opts.resetView) this.resetView();
  }

  _contours(seg, lv) {
    if (this.lines) { this.scene.remove(this.lines); this.lines.geometry.dispose(); this.lines = null; }
    if (!seg?.length) return;
    const p = new Float32Array(seg.length / 4 * 6);
    for (let a = 0, q = 0, n = 0; a < seg.length; a += 4, n++) {
      const y = (lv[n] - this.z0) * this.ex + 0.15 * this.ex;
      p[q++] = (seg[a] - this.cx) * this.k; p[q++] = y; p[q++] = -(seg[a + 1] - this.cy) * this.k;
      p[q++] = (seg[a + 2] - this.cx) * this.k; p[q++] = y; p[q++] = -(seg[a + 3] - this.cy) * this.k;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(p, 3));
    this.lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.85 }));
    this.scene.add(this.lines);
  }

  /** Design features as 3D lines / panels. items: [{ kind: 'line'|'wall', pts: [[x,y,z]...], top?, color }] (native XY). */
  setFeatures(items) {
    if (this.feat) { this.scene.remove(this.feat); this.feat.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); }); }
    this.feat = new THREE.Group();
    for (const it of items || []) {
      const P = ([x, y, zz]) => new THREE.Vector3((x - this.cx) * this.k, (zz - this.z0) * this.ex + 0.2 * this.ex, -(y - this.cy) * this.k);
      if (it.kind === 'wall') {
        // Vertical panel between the bottom and top lines.
        const bot = it.pts.map(P), top = it.top.map(P);
        const pos = [];
        for (let i = 0; i + 1 < bot.length; i++) {
          const a = bot[i], b2 = bot[i + 1], c = top[i + 1], d = top[i];
          pos.push(a.x, a.y, a.z, b2.x, b2.y, b2.z, c.x, c.y, c.z, a.x, a.y, a.z, c.x, c.y, c.z, d.x, d.y, d.z);
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
        geo.computeVertexNormals();
        this.feat.add(new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: 0xc9c4ba, side: THREE.DoubleSide })));
        this.feat.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(top), new THREE.LineBasicMaterial({ color: 0xffffff })));
      } else {
        const pts = it.pts.map(P);
        if (it.closed) pts.push(pts[0].clone());
        this.feat.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: it.color || 0xffffff })));
      }
    }
    this.scene.add(this.feat);
  }

  /** Building massing: flat array of triangle corners [x, y, z, …] (native XY, output Z). */
  setBuildings(tri) {
    if (this.bldg) { this.scene.remove(this.bldg); this.bldg.geometry.dispose(); this.bldg.material.dispose(); this.bldg = null; }
    if (!tri?.length) return;
    const pos = new Float32Array(tri.length);
    for (let i = 0; i < tri.length; i += 3) {
      pos[i] = (tri[i] - this.cx) * this.k; pos[i + 1] = (tri[i + 2] - this.z0) * this.ex; pos[i + 2] = -(tri[i + 1] - this.cy) * this.k;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.computeVertexNormals();
    this.bldg = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: 0xe7e2d8, side: THREE.DoubleSide, flatShading: true }));
    this.scene.add(this.bldg);
  }

  /**
   * Sketch: massing blocks ({ tris: flat [x,y,z…] native XY / output Z, colors: hex per triangle, lines: floor lines })
   * and parking ({ lines: stall lines, acc: accessible stall triangles, stripe, accColor }).
   */
  setSketch(mass, park) {
    if (this.sketch) { this.scene.remove(this.sketch); this.sketch.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); }); this.sketch = null; }
    const g = new THREE.Group();
    const P = (x, y, z) => [(x - this.cx) * this.k, (z - this.z0) * this.ex, -(y - this.cy) * this.k];
    if (mass?.tris?.length) {
      const n = mass.tris.length / 3, pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
      const c = new THREE.Color();
      for (let v = 0; v < n; v++) {
        const q = P(mass.tris[v * 3], mass.tris[v * 3 + 1], mass.tris[v * 3 + 2]);
        pos.set(q, v * 3);
        c.set(mass.colors[Math.floor(v / 3)]);                 // three converts sRGB hex to linear itself
        col[v * 3] = c.r; col[v * 3 + 1] = c.g; col[v * 3 + 2] = c.b;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      geo.computeVertexNormals();
      const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, flatShading: true }));
      m.name = 'sketchMass';
      m.userData.ids = mass.ids || [];
      g.add(m);
      if (mass.lines?.length) {
        const lp = new Float32Array(mass.lines.length);
        for (let i = 0; i < mass.lines.length; i += 3) lp.set(P(mass.lines[i], mass.lines[i + 1], mass.lines[i + 2]), i);
        const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.BufferAttribute(lp, 3));
        g.add(new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0x1f2937, transparent: true, opacity: 0.35 })));
      }
    }
    if (park?.lines?.length) {
      const lp = new Float32Array(park.lines.length);
      for (let i = 0; i < park.lines.length; i += 3) lp.set(P(park.lines[i], park.lines[i + 1], park.lines[i + 2]), i);
      const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.BufferAttribute(lp, 3));
      g.add(new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: park.stripe || '#ffffff' })));
    }
    const fill = (arr, color, opacity = 1) => {
      if (!arr?.length) return;
      const ap = new Float32Array(arr.length);
      for (let i = 0; i < arr.length; i += 3) ap.set(P(arr[i], arr[i + 1], arr[i + 2]), i);
      const ag = new THREE.BufferGeometry(); ag.setAttribute('position', new THREE.BufferAttribute(ap, 3)); ag.computeVertexNormals();
      g.add(new THREE.Mesh(ag, new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide, transparent: opacity < 1, opacity })));
    };
    fill(park?.islands, park?.greenColor || '#8cc084');
    fill(park?.drives, park?.lotColor || '#9aa3ad', 0.85);
    if (park?.marks?.length) {
      const lp = new Float32Array(park.marks.length);
      for (let i = 0; i < park.marks.length; i += 3) lp.set(P(park.marks[i], park.marks[i + 1], park.marks[i + 2]), i);
      const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.BufferAttribute(lp, 3));
      g.add(new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: '#fde047' })));
    }
    if (park?.acc?.length) {
      const ap = new Float32Array(park.acc.length);
      for (let i = 0; i < park.acc.length; i += 3) ap.set(P(park.acc[i], park.acc[i + 1], park.acc[i + 2]), i);
      const ag = new THREE.BufferGeometry(); ag.setAttribute('position', new THREE.BufferAttribute(ap, 3));
      g.add(new THREE.Mesh(ag, new THREE.MeshBasicMaterial({ color: park.accColor || '#2563eb', side: THREE.DoubleSide })));
    }
    this.sketch = g;
    this.scene.add(g);
    if (this.sunMode) this._sketchSun();
  }
  _sketchSun() {
    const m = this.sketch?.getObjectByName('sketchMass');
    if (!m) return;
    m.castShadow = m.receiveShadow = this.sunMode === 'time';
    m.visible = this.sunMode !== 'hours';
    m.material.needsUpdate = true;
  }

  /** Water-flow particles: a Flow instance (native XY); updated every frame while shown. */
  setFlow(flow, sinks) {
    this.flow = flow;
    if (this.flowPts) { this.scene.remove(this.flowPts); this.flowPts.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); }); this.flowPts = null; }
    if (this.pond) { this.scene.remove(this.pond); this.pond.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); }); this.pond = null; }
    if (!flow) { delete this.frames.flow; return; }
    if (sinks?.length) {
      // Ponding spots: translucent blue discs at the water level a low spot would fill to.
      this.pond = new THREE.Group();
      const mat = new THREE.MeshBasicMaterial({ color: 0x3b82f6, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false });
      for (const s of sinks) {
        const r = Math.max(2, (1.5 + Math.min(4, s.depth) * 2) * this.g.s) * this.k;
        const disc = new THREE.Mesh(new THREE.CircleGeometry(r, 28), mat.clone());
        disc.rotation.x = -Math.PI / 2;
        disc.position.set((s.x - this.cx) * this.k, (s.z + Math.min(s.depth, 0.5) - this.z0) * this.ex, -(s.y - this.cy) * this.k);
        this.pond.add(disc);
      }
      this.scene.add(this.pond);
    }
    // Each particle: a bright head plus a tail through its last few positions, fading into the ground.
    const T = 16, n = flow.n;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    this.flowPts = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xbae6fd, size: 3, sizeAttenuation: false }));
    const tgeo = new THREE.BufferGeometry();
    const tp = new Float32Array(n * (T - 1) * 6), tc = new Float32Array(n * (T - 1) * 6);
    for (let p = 0; p < n; p++) for (let t = 0; t < T - 1; t++) {
      for (let e = 0; e < 2; e++) {
        const f = 1 - (t + e) / (T - 1), o = ((p * (T - 1) + t) * 2 + e) * 3;
        tc[o] = 0.11 + (0.49 - 0.11) * f; tc[o + 1] = 0.13 + (0.83 - 0.13) * f; tc[o + 2] = 0.15 + (0.99 - 0.15) * f;
      }
    }
    tgeo.setAttribute('position', new THREE.BufferAttribute(tp, 3));
    tgeo.setAttribute('color', new THREE.BufferAttribute(tc, 3));
    const tails = new THREE.LineSegments(tgeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9 }));
    this.flowPts.add(tails);
    this.flowPts.frustumCulled = tails.frustumCulled = false;
    this.scene.add(this.flowPts);
    const hist = new Float32Array(n * T * 3); // newest first
    let filled = false;
    this.frames.flow = () => {
      flow.step();
      const a = geo.attributes.position.array;
      for (let p = 0; p < n; p++) {
        const zz = flow.zAt(flow.px[p], flow.py[p]);
        const x = (flow.px[p] - this.cx) * this.k, y = Number.isFinite(zz) ? (zz - this.z0) * this.ex + 0.3 * this.ex : -1e5, z = -(flow.py[p] - this.cy) * this.k;
        a[p * 3] = x; a[p * 3 + 1] = y; a[p * 3 + 2] = z;
        const h = p * T * 3;
        if (!filled || flow.age[p] <= 1 || y < -1e4) { for (let t = 0; t < T; t++) { hist[h + t * 3] = x; hist[h + t * 3 + 1] = y; hist[h + t * 3 + 2] = z; } }
        else { hist.copyWithin(h + 3, h, h + (T - 1) * 3); hist[h] = x; hist[h + 1] = y; hist[h + 2] = z; }
        for (let t = 0; t < T - 1; t++) {
          const o = (p * (T - 1) + t) * 6;
          tp[o] = hist[h + t * 3]; tp[o + 1] = hist[h + t * 3 + 1]; tp[o + 2] = hist[h + t * 3 + 2];
          tp[o + 3] = hist[h + t * 3 + 3]; tp[o + 4] = hist[h + t * 3 + 4]; tp[o + 5] = hist[h + t * 3 + 5];
        }
      }
      filled = true;
      geo.attributes.position.needsUpdate = true;
      tgeo.attributes.position.needsUpdate = true;
    };
  }

  /**
   * Sun. mode 'off' (default lighting), 'time' (light from the sun's position with cast shadows) or 'hours'
   * (terrain and buildings coloured by hours of direct sun). opts:
   *   time:  { dir: [x, y, z] toward the sun in scene axes, alt (degrees) }
   *   hours: { colorAt(x, y) -> [r, g, b] for native XY on the ground,
   *            surf: { S (positions: native XY, output Z, as the buildings are drawn), idx, col (r, g, b per point) } }
   */
  setSun(mode, opts = {}) {
    const R = this.renderer, sun = this.sun, hemi = this.scene.children.find(o => o.isHemisphereLight);
    const size = this.g ? Math.max((this.g.nx - 1) * this.g.s, (this.g.ny - 1) * this.g.s) * this.k : 1000;
    const mid = this.g ? ((this.zmin + this.zmax) / 2 - this.z0) * this.ex : 0;
    // Restore the defaults first.
    R.shadowMap.enabled = false;
    sun.castShadow = false;
    sun.position.set(-0.6, 1, 0.45); sun.intensity = 1.35;
    if (sun.target.parent) { sun.target.position.set(0, 0, 0); }
    if (hemi) hemi.intensity = 0.85;
    if (this.mesh) { this.mesh.castShadow = this.mesh.receiveShadow = false; }
    if (this.bldg) { this.bldg.castShadow = this.bldg.receiveShadow = false; this.bldg.visible = true; }
    if (this.sunSurf) { this.scene.remove(this.sunSurf); this.sunSurf.geometry.dispose(); this.sunSurf.material.dispose(); this.sunSurf = null; }
    if (this.mat && this._sunMap !== undefined) { this.mat.map = this._sunMap; this.mat.needsUpdate = true; this._sunMap = undefined; this._sunColorsDirty = true; }
    if (this.mat) this.mat.needsUpdate = true;
    if (this.bldg) this.bldg.material.needsUpdate = true;
    this.sunMode = mode;
    this._sketchSun();
    if (mode === 'time') {
      if (!sun.target.parent) this.scene.add(sun.target);
      sun.target.position.set(0, mid, 0);
      const [dx, dy, dz] = opts.dir;
      sun.position.set(dx * size * 2, mid + dy * size * 2, dz * size * 2);
      const up = Math.max(0, Math.min(1, opts.alt / 12));            // fades in over the first 12° above the horizon
      sun.intensity = opts.alt > 0 ? 0.25 + 1.55 * up : 0;
      if (hemi) hemi.intensity = opts.alt > 0 ? 0.45 + 0.15 * up : 0.3;
      R.shadowMap.enabled = opts.alt > 0;
      R.shadowMap.type = THREE.PCFSoftShadowMap;
      sun.castShadow = opts.alt > 0;
      const cam = sun.shadow.camera, half = size * 0.75;
      cam.left = -half; cam.right = half; cam.top = half; cam.bottom = -half;
      cam.near = size * 0.5; cam.far = size * 5;
      cam.updateProjectionMatrix();
      sun.shadow.mapSize.set(4096, 4096);
      sun.shadow.bias = -0.0004; sun.shadow.normalBias = size * 0.0006;
      sun.shadow.map?.dispose(); sun.shadow.map = null;
      if (this.mesh) { this.mesh.castShadow = true; this.mesh.receiveShadow = true; }
      if (this.bldg) { this.bldg.castShadow = true; this.bldg.receiveShadow = true; }
      R.shadowMap.needsUpdate = true;
      if (this.mat) this.mat.needsUpdate = true;          // shaders recompile with shadows on
      if (this.bldg) this.bldg.material.needsUpdate = true;
    } else if (mode === 'hours') {
      if (this.mesh && opts.colorAt) {
        const geo = this.mesh.geometry, pos = geo.attributes.position.array, col = geo.attributes.color.array;
        for (let q = 0; q < pos.length / 3; q++) {
          const x = pos[q * 3] / this.k + this.cx, y = -pos[q * 3 + 2] / this.k + this.cy;
          const c = opts.colorAt(x, y);
          col[q * 3] = c[0]; col[q * 3 + 1] = c[1]; col[q * 3 + 2] = c[2];
        }
        geo.attributes.color.needsUpdate = true;
        this._sunMap = this.mat.map; this.mat.map = null; this.mat.needsUpdate = true;
      }
      if (opts.surf?.idx?.length) {
        // Roofs and walls split into small triangles, each corner coloured by its own sun hours.
        const S = opts.surf.S, n = S.length / 3, pos = new Float32Array(n * 3);
        for (let v = 0; v < n; v++) {
          pos[v * 3] = (S[v * 3] - this.cx) * this.k; pos[v * 3 + 1] = (S[v * 3 + 2] - this.z0) * this.ex; pos[v * 3 + 2] = -(S[v * 3 + 1] - this.cy) * this.k;
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.setAttribute('color', new THREE.BufferAttribute(opts.surf.col, 3));
        geo.setIndex(new THREE.BufferAttribute(opts.surf.idx, 1));
        geo.computeVertexNormals();
        // Unlit, so a colour reads exactly as the legend (lighting made sunny walls look dull) — with a light shade
        // by orientation (roofs full, walls a little darker) so the forms stay readable.
        const nrm = geo.attributes.normal.array, src = opts.surf.col, col = new Float32Array(src.length), lin = new THREE.Color();
        for (let v = 0; v < n; v++) {
          const f = 0.8 + 0.2 * Math.abs(nrm[v * 3 + 1]);
          lin.setRGB(src[v * 3], src[v * 3 + 1], src[v * 3 + 2], THREE.SRGBColorSpace);
          col[v * 3] = lin.r * f; col[v * 3 + 1] = lin.g * f; col[v * 3 + 2] = lin.b * f;
        }
        geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
        this.sunSurf = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
        this.scene.add(this.sunSurf);
        if (this.bldg) this.bldg.visible = false;
      }
    }
  }

  /** Wind streaks: a WindField (native XY), drawn a little above the ground, updated every frame while shown. */
  setWind(field, zAt) {
    if (this.windPts) { this.scene.remove(this.windPts); this.windPts.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); }); this.windPts = null; }
    delete this.frames.wind;
    if (!field) return;
    const T = 12, n = field.n;
    const tp = new Float32Array(n * (T - 1) * 6), tc = new Float32Array(n * (T - 1) * 6);
    const BG = [0.11, 0.13, 0.15];                                     // tails fade toward the background
    const tgeo = new THREE.BufferGeometry();
    tgeo.setAttribute('position', new THREE.BufferAttribute(tp, 3));
    tgeo.setAttribute('color', new THREE.BufferAttribute(tc, 3));
    this.windPts = new THREE.LineSegments(tgeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85 }));
    this.windPts.frustumCulled = false;
    this.scene.add(this.windPts);
    const hist = new Float32Array(n * T * 3);
    const lift = (this.g ? this.g.s : 3) * 6 * this.k;                  // streaks float a little above the ground
    let filled = false;
    this.frames.wind = () => {
      field.step();
      for (let p = 0; p < n; p++) {
        const inside = field.inBox(p), zz = inside ? zAt(field.px[p], field.py[p]) : NaN;
        const x = (field.px[p] - this.cx) * this.k, y = Number.isFinite(zz) ? (zz - this.z0) * this.ex + lift : -1e5, z = -(field.py[p] - this.cy) * this.k;
        const h = p * T * 3;
        if (!filled || field.age[p] <= 1 || y < -1e4) { for (let t = 0; t < T; t++) { hist[h + t * 3] = x; hist[h + t * 3 + 1] = y; hist[h + t * 3 + 2] = z; } }
        else { hist.copyWithin(h + 3, h, h + (T - 1) * 3); hist[h] = x; hist[h + 1] = y; hist[h + 2] = z; }
        const col = field.color(p);
        for (let t = 0; t < T - 1; t++) {
          const o = (p * (T - 1) + t) * 6;
          tp[o] = hist[h + t * 3]; tp[o + 1] = hist[h + t * 3 + 1]; tp[o + 2] = hist[h + t * 3 + 2];
          tp[o + 3] = hist[h + t * 3 + 3]; tp[o + 4] = hist[h + t * 3 + 4]; tp[o + 5] = hist[h + t * 3 + 5];
          for (let e = 0; e < 2; e++) {
            const f = 1 - (t + e) / (T - 1), c = o + e * 3;
            tc[c] = BG[0] + (col[0] - BG[0]) * f; tc[c + 1] = BG[1] + (col[1] - BG[1]) * f; tc[c + 2] = BG[2] + (col[2] - BG[2]) * f;
          }
        }
      }
      filled = true;
      tgeo.attributes.position.needsUpdate = true;
      tgeo.attributes.color.needsUpdate = true;
    };
  }

  setExaggeration(ex) { this.ex = ex; }

  // ---- Sketching in 3D: native XY + output Z <-> screen, and picking the ground / sketch blocks under the cursor.
  world(x, y, z) { return new THREE.Vector3((x - this.cx) * this.k, (z - this.z0) * this.ex, -(y - this.cy) * this.k); }
  native(v) { return [v.x / this.k + this.cx, -v.z / this.k + this.cy, v.y / this.ex + this.z0]; }
  /** Screen position (px in the stage) of a native point, or null when it is behind the camera. */
  project(x, y, z) {
    const v = this.world(x, y, z).project(this.camera);
    if (v.z > 1 || v.z < -1) return null;
    return [(v.x + 1) / 2 * this.el.clientWidth, (1 - v.y) / 2 * this.el.clientHeight];
  }
  _ray(sx, sy) {
    this._rc = this._rc || new THREE.Raycaster();
    this._rc.setFromCamera(new THREE.Vector2(sx / this.el.clientWidth * 2 - 1, 1 - sy / this.el.clientHeight * 2), this.camera);
    return this._rc;
  }
  /** Terrain height (world y) under world (X, Z), from the displayed mesh; NaN off the model. */
  groundY(X, Z) {
    const g = this.g, m = this.mesh; if (!g || !m) return NaN;
    const { cols, rows } = m.userData, st = this.step;
    const c = ((X / this.k + this.cx) - g.x0) / (g.s * st), r = ((-Z / this.k + this.cy) - g.y0) / (g.s * st);
    if (!(c >= 0 && r >= 0 && c <= cols - 1 && r <= rows - 1)) return NaN;
    const c0 = Math.min(cols - 2, Math.floor(c)), r0 = Math.min(rows - 2, Math.floor(r)), fc = c - c0, fr = r - r0;
    const P = m.geometry.attributes.position.array, y = (rr, cc) => P[(rr * cols + cc) * 3 + 1];
    return (y(r0, c0) * (1 - fc) + y(r0, c0 + 1) * fc) * (1 - fr) + (y(r0 + 1, c0) * (1 - fc) + y(r0 + 1, c0 + 1) * fc) * fr;
  }
  /** Ground point under the cursor: [x, y, z] native XY + output Z, or null. Marches the ray over the height grid. */
  pickGround(sx, sy) {
    if (!this.mesh) return null;
    const { ray } = this._ray(sx, sy), o = ray.origin, d = ray.direction;
    const bb = this.mesh.geometry.boundingBox || (this.mesh.geometry.computeBoundingBox(), this.mesh.geometry.boundingBox);
    const ymax = bb.max.y + 1, ymin = bb.min.y - 1;
    let t0 = 0, t1;
    if (o.y > ymax) { if (d.y >= 0) return null; t0 = (ymax - o.y) / d.y; }
    t1 = d.y < 0 ? (ymin - o.y) / d.y : t0 + this.camera.far;
    const cell = this.g.s * this.step * this.k * 0.5, h = Math.hypot(d.x, d.z);
    const dt = Math.max((t1 - t0) / 6000, cell / Math.max(h, 1e-3));
    const f = t => { const y = this.groundY(o.x + d.x * t, o.z + d.z * t); return Number.isNaN(y) ? NaN : o.y + d.y * t - y; };
    let pt = t0, pf = f(t0);
    for (let t = t0 + dt; t <= t1 + dt; t += dt) {
      const ft = f(t);
      if (pf > 0 && ft <= 0) {
        let a = pt, b = t;
        for (let i = 0; i < 24; i++) { const mid = (a + b) / 2; if (f(mid) > 0) a = mid; else b = mid; }
        return this.native(o.clone().addScaledVector(d, b));
      }
      if (!Number.isNaN(ft)) { pt = t; pf = ft; }
    }
    return null;
  }
  /** Point on the horizontal plane at output elevation z under the cursor (native XY), or null. */
  pickPlane(sx, sy, z) {
    const { ray } = this._ray(sx, sy), o = ray.origin, d = ray.direction, Y = (z - this.z0) * this.ex;
    if (Math.abs(d.y) < 1e-9) return null;
    const t = (Y - o.y) / d.y; if (t <= 0) return null;
    return this.native(o.clone().addScaledVector(d, t)).slice(0, 2);
  }
  /** Sketch block under the cursor: { id, at: [x, y, z] } or null. */
  pickSketch(sx, sy) {
    const m = this.sketch?.getObjectByName('sketchMass');
    if (!m) return null;                       // (still pickable while sun hours hide it behind the coloured copy)
    const hit = this._ray(sx, sy).intersectObject(m, false)[0];
    if (!hit) return null;
    return { id: m.userData.ids[hit.faceIndex], at: this.native(hit.point) };
  }
  /** While a sketch drawing tool is on, the left button is the pen: right-drag orbits, Shift+right-drag pans. */
  sketchNav(on) {
    this.controls.mouseButtons = on ? { LEFT: -1, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE }
      : { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
  }

  /** Navigation speed multiplier (1 = default). */
  setSpeed(m) {
    this.controls.rotateSpeed = 0.45 * m;
    this.controls.panSpeed = 0.5 * m;
    this.controls.zoomSpeed = 1.2 * m;
  }

  resetView() {
    const g = this.g, k = this.k;
    const w = (g.nx - 1) * g.s * k, h = (g.ny - 1) * g.s * k, size = Math.max(w, h);
    const mid = ((this.zmin + this.zmax) / 2 - this.z0) * this.ex;
    this.controls.target.set(0, mid, 0);
    this.controls.minDistance = size * 0.03; this.controls.maxDistance = size * 4;
    this.camera.near = size / 500; this.camera.far = size * 20;
    this.scene.fog.near = size * 2.5; this.scene.fog.far = size * 6;
    this.camera.position.set(-size * 0.55, size * 0.6 + mid, size * 0.85);
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  dispose() {
    this.visible = false;
    this._ro.disconnect();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
