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
    this.sketchNav(false);
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

  /** Building massing: flat array of triangle corners [x, y, z, …] (native XY, output Z).
   *  opt: { keys: building key per triangle (for picking), colors: hex per triangle for the diagram look }. */
  setBuildings(tri, opt = {}) {
    this._bldgOpt = opt;
    if (this.bldg) { this.scene.remove(this.bldg); this.bldg.geometry.dispose(); this.bldg.material.dispose(); this.bldg = null; }
    if (this.bldgEdges) { this.scene.remove(this.bldgEdges); this.bldgEdges.geometry.dispose(); this.bldgEdges.material.dispose(); this.bldgEdges = null; }
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
    this._bldgStyle();
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
      const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, flatShading: true, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
      m.name = 'sketchMass';
      m.userData.ids = mass.ids || [];
      m.userData.faces = mass.fis || [];
      g.add(m);
      if (mass.lines?.length) {
        const lp = new Float32Array(mass.lines.length);
        for (let i = 0; i < mass.lines.length; i += 3) lp.set(P(mass.lines[i], mass.lines[i + 1], mass.lines[i + 2]), i);
        const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.BufferAttribute(lp, 3));
        g.add(new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0x1f2937, transparent: true, opacity: 0.35 })));
      }
      if (mass.edges?.length) {                                 // crisp outlines, like a SketchUp model
        const ep = new Float32Array(mass.edges.length);
        for (let i = 0; i < mass.edges.length; i += 3) ep.set(P(mass.edges[i], mass.edges[i + 1], mass.edges[i + 2]), i);
        const eg = new THREE.BufferGeometry(); eg.setAttribute('position', new THREE.BufferAttribute(ep, 3));
        const el = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: 0x111827, transparent: true, opacity: 0.85 }));
        el.name = 'sketchEdges';
        g.add(el);
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
    for (const x of park?.extra || []) fill(x.tris, x.color);
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

  /**
   * Existing trees: [{ x, y (native), z (ground, output), h (output), r (native) }] as abstract low-poly trees at
   * true height on the exaggerated ground (like the buildings). Several crown forms — rounded clusters, ovals,
   * spreading canopies, columns and conifers — picked from each tree's proportions and position, turned and
   * tinted a little differently. Diagram look: pale crowns with outlines.
   */
  setTrees(list, opt = {}) {
    this._treeOpt = opt;
    if (this.trees) { this.scene.remove(this.trees); this.trees.traverse(o => { if (o.geometry && !o.geometry.userData.shared) o.geometry.dispose(); o.material?.dispose(); }); this.trees = null; }
    this._treeList = list;
    if (!list?.length || !this.g) return;
    const F = (this._treeForms ||= treeForms());
    const g = new THREE.Group(), dg = !!this.diagram;
    const hash = t => { const v = Math.sin(t.x * 12.9898 + t.y * 78.233) * 43758.5453; return v - Math.floor(v); };
    // Pick a form per tree.
    const byForm = new Map();
    // Forms for Arkansas: mostly broadleaf crowns; pines (shortleaf / loblolly: tall bare trunk, open crown on top) and
    // eastern red cedar (dense narrow teardrop) where the lidar says evergreen (t.ev ≥ 0.6, leaf-off density), or —
    // without that — only for very slender trees.
    list.forEach(t => {
      const u = hash(t), ratio = t.h / Math.max(0.1, 2 * t.r * this.k), ev = t.ev == null ? null : t.ev >= 0.6;
      const form = t.form === 'pine' || t.form === 'cedar' ? t.form : t.form === 'broadleaf' ? (ratio < 0.95 ? 'spread' : ['round', 'oval', 'cluster', 'lumpy'][Math.floor(u * 4)])
        : ev === true ? (ratio > 2.2 && u < 0.5 ? 'cedar' : 'pine')
        : ev == null && ratio > 2.6 ? (u < 0.5 ? 'cedar' : 'pine')
        : ratio < 0.95 ? (u < 0.6 ? 'spread' : 'round') : ['round', 'oval', 'cluster', 'lumpy'][Math.floor(u * 4)];
      if (!byForm.has(form)) byForm.set(form, []);
      byForm.get(form).push(t);
    });
    const M = new THREE.Matrix4(), q = new THREE.Quaternion(), c = new THREE.Color(), up = new THREE.Vector3(0, 1, 0);
    const trunks = new THREE.InstancedMesh(F.trunk, new THREE.MeshLambertMaterial({ color: dg ? 0xb9b4aa : 0x5e4633 }), list.length);
    const base = new THREE.Color(opt.base || '#d7e3d4'), hsl = {}; base.getHSL(hsl);
    let ti = 0;
    for (const [form, L] of byForm) {
      const geo = F[form], crowns = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true }), L.length);
      const conifer = form === 'cedar' || form === 'pine';
      L.forEach((t, i) => {
        const u = hash(t), X = (t.x - this.cx) * this.k, Z = -(t.y - this.cy) * this.k, Y0 = (t.z - this.z0) * this.ex;
        const r = Math.max(0.6, t.r * this.k), h = Math.max(1.5, t.h);
        const crownH = form === 'cedar' ? h * (0.82 + 0.1 * u) : form === 'pine' ? h * (0.42 + 0.14 * u) : form === 'spread' ? Math.min(h * 0.5, r * 1.1) : Math.min(h * (0.62 + 0.12 * u), r * 2.2);
        const trunkH = h - crownH;
        q.setFromAxisAngle(up, u * Math.PI * 2);
        // Crown width = the lidar crown diameter, top = the lidar tree height (variety comes from form and turn only).
        M.compose(new THREE.Vector3(X, Y0 + trunkH + crownH / 2, Z), q, new THREE.Vector3(r, crownH / 2, r));
        crowns.setMatrixAt(i, M);
        const painted = dg && opt.paint?.(t);
        if (painted) c.set(painted);
        else if (dg) c.setHSL(hsl.h, hsl.s, Math.max(0, Math.min(1, hsl.l + (u - 0.5) * 0.06)));
        else if (form === 'cedar') c.setHSL(0.33 + 0.04 * u, 0.32, 0.17 + 0.05 * u);
        else if (form === 'pine') c.setHSL(0.27 + 0.05 * u, 0.36, 0.22 + 0.06 * u);
        else c.setHSL(0.24 + 0.08 * u, 0.40 + 0.12 * u, 0.24 + 0.10 * ((u * 7) % 1));
        crowns.setColorAt(i, c);
        const tr = Math.max(0.2, r * (form === 'pine' ? 0.1 : conifer ? 0.06 : 0.08));
        M.compose(new THREE.Vector3(X, Y0 + (trunkH + crownH * 0.3) / 2, Z), q, new THREE.Vector3(tr, trunkH + crownH * 0.3, tr));
        trunks.setMatrixAt(ti++, M);
      });
      crowns.castShadow = true;
      crowns.userData.list = L; crowns.name = 'crowns';
      g.add(crowns);
      if (dg) {                                             // crisp outlines for the diagram look
        const eg = F.edges[form], pos = eg.attributes.position.array, out = new Float32Array(pos.length * L.length), v = new THREE.Vector3();
        L.forEach((t, i) => { crowns.getMatrixAt(i, M); for (let k = 0; k < pos.length; k += 3) { v.set(pos[k], pos[k + 1], pos[k + 2]).applyMatrix4(M); out[i * pos.length + k] = v.x; out[i * pos.length + k + 1] = v.y; out[i * pos.length + k + 2] = v.z; } });
        const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.BufferAttribute(out, 3));
        g.add(new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: base.clone().multiplyScalar(0.55), transparent: true, opacity: 0.6 })));
      }
    }
    trunks.castShadow = true;
    g.add(trunks);
    g.name = 'trees';
    this.trees = g; this.scene.add(g);
  }

  /** Diagram annotations: [{ tris: flat display [x,y,z…], edges: flat display pairs, color, opacity }]. */
  setNotes(items) {
    if (this.notes) { this.scene.remove(this.notes); this.notes.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); }); this.notes = null; }
    if (!items?.length) return;
    const g = new THREE.Group(), P = (x, y, z) => [(x - this.cx) * this.k, (z - this.z0) * this.ex, -(y - this.cy) * this.k];
    const buf = arr => { const a = new Float32Array(arr.length); for (let i = 0; i < arr.length; i += 3) a.set(P(arr[i], arr[i + 1], arr[i + 2]), i); return a; };
    for (const it of items) {
      if (it.tris?.length) {
        const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(buf(it.tris), 3)); geo.computeVertexNormals();
        const op = it.opacity ?? 1;
        g.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: it.color, side: THREE.DoubleSide, transparent: op < 1, opacity: op, depthWrite: op >= 1, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })));
      }
      if (it.edges?.length) {
        const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(buf(it.edges), 3));
        g.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: it.edgeColor || it.color })));
      }
    }
    this.notes = g; this.scene.add(g);
  }
  /** Diagram look: light background, pale buildings with crisp outlines. */
  setDiagram(on) {
    this.diagram = on;
    const bg = on ? 0xf6f6f3 : 0x1c2226;
    this.renderer.setClearColor(bg); this.scene.fog.color.set(bg);
    this._hemi = this._hemi || this.scene.children.find(o => o.isHemisphereLight);
    if (this._hemi) this._hemi.intensity = on ? 1.15 : 0.85;
    this._bldgStyle();
    if (this._treeList && this._treeDg !== on) { this._treeDg = on; this.setTrees(this._treeList, this._treeOpt); }
  }
  _bldgStyle() {
    if (!this.bldg) return;
    const cols = this.diagram && this._bldgOpt?.colors, geo = this.bldg.geometry;
    if (cols) {
      const n = geo.attributes.position.count, a = new Float32Array(n * 3), c = new THREE.Color();
      for (let v = 0; v < n; v++) { c.set(cols[Math.floor(v / 3)] || '#f4f4f1'); a[v * 3] = c.r; a[v * 3 + 1] = c.g; a[v * 3 + 2] = c.b; }
      geo.setAttribute('color', new THREE.BufferAttribute(a, 3));
    }
    this.bldg.material.vertexColors = !!cols;
    this.bldg.material.color.set(cols ? 0xffffff : this.diagram ? 0xf4f4f1 : 0xe7e2d8);
    this.bldg.material.needsUpdate = true;
    if (this.bldgEdges) { this.scene.remove(this.bldgEdges); this.bldgEdges.geometry.dispose(); this.bldgEdges.material.dispose(); this.bldgEdges = null; }
    if (this.diagram) {
      this.bldgEdges = new THREE.LineSegments(new THREE.EdgesGeometry(this.bldg.geometry, 25), new THREE.LineBasicMaterial({ color: 0x6b7280 }));
      this.scene.add(this.bldgEdges);
    }
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

  /** The current view as an image (renders a frame first so the drawing buffer is fresh). */
  snapshot() {
    this.controls.update();
    for (const f of Object.values(this.frames)) f();
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement;
  }

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
  /** Two points on the cursor ray, as native XY + output Z (as displayed). */
  rayPoints(sx, sy) {
    const { ray } = this._ray(sx, sy);
    return [this.native(ray.origin), this.native(ray.origin.clone().addScaledVector(ray.direction, this.camera.far * 0.1))];
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
    return { id: m.userData.ids[hit.faceIndex], face: m.userData.faces[hit.faceIndex], at: this.native(hit.point) };
  }
  /** What the diagram paint bucket hits: the nearest sketch block, existing building or tree under the cursor.
   *  → { kind: 'mass', id } | { kind: 'bldg', key } | { kind: 'tree', tree } | null */
  pickPaint(sx, sy) {
    const objs = [];
    const sm = this.sketch?.getObjectByName('sketchMass'); if (sm) objs.push(sm);
    if (this.bldg?.visible) objs.push(this.bldg);
    this.trees?.children.forEach(o => { if (o.name === 'crowns') objs.push(o); });
    if (!objs.length) return null;
    const hit = this._ray(sx, sy).intersectObjects(objs, false)[0];
    if (!hit) return null;
    if (hit.object === sm) return { kind: 'mass', id: sm.userData.ids[hit.faceIndex] };
    if (hit.object === this.bldg) { const key = this._bldgOpt?.keys?.[hit.faceIndex]; return key ? { kind: 'bldg', key } : null; }
    const t = hit.object.userData.list?.[hit.instanceId];
    return t ? { kind: 'tree', tree: t } : null;
  }
  /** Mouse buttons: wheel-drag pans and Shift+wheel-drag orbits (Revit-style) everywhere. Otherwise left-drag
   *  orbits and right-drag pans — except while a sketch drawing tool is on, when left is the pen and right orbits. */
  sketchNav(on) {
    this.controls.mouseButtons = on ? { LEFT: -1, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE }
      : { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
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

/**
 * Crown forms for the trees, each fitting a unit sphere (x, z in −1…1, y in −1…1), built once. Clusters of lumpy
 * low-poly blobs read as abstract trees rather than lollipops; conifers are stacked cones.
 */
function treeForms() {
  let seed = 11;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const blob = (cx, cy, cz, rx, ry, rz, detail = 1, lump = 0.18) => {
    const g = new THREE.IcosahedronGeometry(1, detail).toNonIndexed(), p = g.attributes.position;
    const key = new Map();
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i), k = `${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}`;
      let f = key.get(k); if (f == null) { f = 1 + (rnd() - 0.5) * 2 * lump; key.set(k, f); }
      p.setXYZ(i, cx + x * rx * f, cy + y * ry * f, cz + z * rz * f);
    }
    return g;
  };
  const merge = (parts) => {
    let n = 0; for (const g of parts) n += g.attributes.position.count;
    const pos = new Float32Array(n * 3); let o = 0;
    for (const g of parts) { pos.set(g.attributes.position.array, o); o += g.attributes.position.array.length; g.dispose(); }
    // Fit to the unit box so instance scales mean crown radius / half-height.
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < pos.length; i += 3) { x0 = Math.min(x0, pos[i]); x1 = Math.max(x1, pos[i]); y0 = Math.min(y0, pos[i + 1]); y1 = Math.max(y1, pos[i + 1]); z0 = Math.min(z0, pos[i + 2]); z1 = Math.max(z1, pos[i + 2]); }
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2, sx = 2 / (x1 - x0), sy = 2 / (y1 - y0), sz = 2 / (z1 - z0);
    for (let i = 0; i < pos.length; i += 3) { pos[i] = (pos[i] - cx) * sx; pos[i + 1] = (pos[i + 1] - cy) * sy; pos[i + 2] = (pos[i + 2] - cz) * sz; }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.computeVertexNormals();
    g.userData.shared = true;
    return g;
  };
  const cluster = (n, spreadXZ, spreadY, size) => merge(Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2 + rnd() * 0.8, d = i === 0 ? 0 : spreadXZ * (0.5 + 0.5 * rnd());
    const s = size * (0.75 + 0.4 * rnd());
    return blob(Math.cos(a) * d, (rnd() - 0.4) * spreadY, Math.sin(a) * d, s, s * (0.85 + 0.3 * rnd()), s, 1, 0.2);
  }));
  const F = {
    round: cluster(5, 0.55, 0.5, 0.62),
    oval: merge([blob(0, 0, 0, 0.8, 1.2, 0.8, 1, 0.2), blob(0.25, 0.55, 0.1, 0.55, 0.6, 0.55, 1, 0.2), blob(-0.3, -0.35, -0.1, 0.6, 0.55, 0.6, 1, 0.2)]),
    cluster: cluster(7, 0.75, 0.7, 0.5),
    lumpy: merge([blob(0, 0, 0, 1, 0.9, 1, 2, 0.28)]),
    spread: merge([...Array.from({ length: 6 }, (_, i) => { const a = i / 6 * Math.PI * 2 + rnd(); return blob(Math.cos(a) * 0.75, (rnd() - 0.5) * 0.25, Math.sin(a) * 0.75, 0.55, 0.32, 0.55, 1, 0.22); }), blob(0, 0.15, 0, 0.7, 0.4, 0.7, 1, 0.2)]),
    // Eastern red cedar: one dense, slightly lumpy teardrop.
    cedar: (() => { const g = new THREE.ConeGeometry(1, 2.2, 9, 4).toNonIndexed(), p = g.attributes.position; for (let i = 0; i < p.count; i++) { const y = p.getY(i), k = 1 + (rnd() - 0.5) * 0.18, bulge = 1 + 0.25 * Math.sin((y + 1.1) / 2.2 * Math.PI); p.setXYZ(i, p.getX(i) * k * bulge, y, p.getZ(i) * k * bulge); } return merge([g]); })(),
    // Pine: an open, flat-topped crown of a few irregular clumps (the tall bare trunk comes from the crown height).
    pine: merge([blob(0, 0.2, 0, 0.8, 0.45, 0.75, 1, 0.25), blob(0.55, -0.15, 0.25, 0.5, 0.32, 0.5, 1, 0.25), blob(-0.5, -0.05, -0.3, 0.55, 0.35, 0.5, 1, 0.25), blob(0.1, -0.35, -0.45, 0.42, 0.28, 0.42, 1, 0.25)]),
    trunk: (() => { const g = new THREE.CylinderGeometry(0.65, 1, 1, 6); g.userData.shared = true; return g; })(),
  };
  F.edges = {};
  for (const k of ['round', 'oval', 'cluster', 'lumpy', 'spread', 'cedar', 'pine']) F.edges[k] = new THREE.EdgesGeometry(F[k], 35);
  return F;
}
