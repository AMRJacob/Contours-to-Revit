// Minimal AutoCAD R12 (AC1009) ASCII DXF writer: 3D polylines, points, text, named layers.
// R12 is the most widely readable DXF flavour (Revit, AutoCAD, Civil 3D, SketchUp, Rhino).

const f = v => (Math.round(v * 10000) / 10000).toString();

export class Dxf {
  /** units: 'ft' | 'm' — written as $INSUNITS/$MEASUREMENT so CAD/Revit "Auto-Detect" picks the right scale. */
  constructor(units = 'ft') {
    this.units = units;
    this.layers = new Map();
    this.ents = [];
    this.min = [Infinity, Infinity, Infinity];
    this.max = [-Infinity, -Infinity, -Infinity];
  }

  layer(name, color = 7) {
    this.layers.set(name, color);
    return this;
  }

  _ext(x, y, z) {
    if (x < this.min[0]) this.min[0] = x; if (y < this.min[1]) this.min[1] = y; if (z < this.min[2]) this.min[2] = z;
    if (x > this.max[0]) this.max[0] = x; if (y > this.max[1]) this.max[1] = y; if (z > this.max[2]) this.max[2] = z;
  }

  /** 3D polyline: pts = [[x,y,z], ...]. Z is stored on every vertex (true 3D geometry). */
  polyline3d(layer, pts, closed = false) {
    const out = ['0', 'POLYLINE', '8', layer, '66', '1', '10', '0', '20', '0', '30', '0', '70', String(8 | (closed ? 1 : 0))];
    for (const [x, y, z] of pts) {
      this._ext(x, y, z);
      out.push('0', 'VERTEX', '8', layer, '10', f(x), '20', f(y), '30', f(z), '70', '32');
    }
    out.push('0', 'SEQEND', '8', layer);
    this.ents.push(out.join('\r\n'));
  }

  /** 3DFACE from 3 or 4 [x,y,z] corners (a triangle repeats its last corner). */
  face3d(layer, corners) {
    const c = corners.length === 3 ? [...corners, corners[2]] : corners;
    const out = ['0', '3DFACE', '8', layer];
    c.forEach(([x, y, z], i) => {
      this._ext(x, y, z);
      out.push(String(10 + i), f(x), String(20 + i), f(y), String(30 + i), f(z));
    });
    this.ents.push(out.join('\r\n'));
  }

  point(layer, x, y, z) {
    this._ext(x, y, z);
    this.ents.push(['0', 'POINT', '8', layer, '10', f(x), '20', f(y), '30', f(z)].join('\r\n'));
  }

  /** Text centred (middle) on x,y,z, rotated `angle` degrees. */
  text(layer, x, y, z, height, str, angle = 0) {
    this._ext(x, y, z);
    this.ents.push(['0', 'TEXT', '8', layer, '10', f(x), '20', f(y), '30', f(z), '40', f(height), '1', str,
      '50', f(angle), '72', '4', '11', f(x), '21', f(y), '31', f(z)].join('\r\n'));
  }

  toString() {
    const ext = (code, v) => [code[0], f(v[0]), code[1], f(v[1]), code[2], f(v[2])];
    const okExt = Number.isFinite(this.min[0]);
    const header = ['0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1009',
      // Drawing units: $INSUNITS 2 = feet, 6 = meters; $MEASUREMENT 0 = imperial, 1 = metric.
      '9', '$INSUNITS', '70', this.units === 'm' ? '6' : '2',
      '9', '$MEASUREMENT', '70', this.units === 'm' ? '1' : '0',
      '9', '$LUNITS', '70', '2',
      '9', '$INSBASE', '10', '0', '20', '0', '30', '0'];
    if (okExt) header.push('9', '$EXTMIN', ...ext(['10', '20', '30'], this.min), '9', '$EXTMAX', ...ext(['10', '20', '30'], this.max));
    header.push('0', 'ENDSEC');
    const tables = ['0', 'SECTION', '2', 'TABLES',
      '0', 'TABLE', '2', 'LTYPE', '70', '1',
      '0', 'LTYPE', '2', 'CONTINUOUS', '70', '0', '3', 'Solid line', '72', '65', '73', '0', '40', '0.0',
      '0', 'ENDTAB',
      '0', 'TABLE', '2', 'LAYER', '70', String(this.layers.size + 1),
      '0', 'LAYER', '2', '0', '70', '0', '62', '7', '6', 'CONTINUOUS'];
    for (const [name, color] of this.layers) tables.push('0', 'LAYER', '2', name, '70', '0', '62', String(color), '6', 'CONTINUOUS');
    tables.push('0', 'ENDTAB', '0', 'ENDSEC');
    return [header.join('\r\n'), tables.join('\r\n'), ['0', 'SECTION', '2', 'ENTITIES'].join('\r\n'),
      ...this.ents, ['0', 'ENDSEC', '0', 'EOF'].join('\r\n')].join('\r\n') + '\r\n';
  }
}
