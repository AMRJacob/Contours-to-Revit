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
    if (this.onFrame) this.onFrame();
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

  /** Water-flow particles: a Flow instance (native XY); updated every frame while shown. */
  setFlow(flow, sinks) {
    this.flow = flow;
    if (this.flowPts) { this.scene.remove(this.flowPts); this.flowPts.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); }); this.flowPts = null; }
    if (this.pond) { this.scene.remove(this.pond); this.pond.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); }); this.pond = null; }
    if (!flow) { this.onFrame = null; return; }
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
    this.onFrame = () => {
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

  setExaggeration(ex) { this.ex = ex; }

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
