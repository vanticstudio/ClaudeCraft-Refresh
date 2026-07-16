// Axis-aligned bounding box (01 §12). min/max are [x,y,z] arrays so axis
// indices (0=X, 1=Y, 2=Z) index directly into them in the collision solver.

export class AABB {
  constructor(x0 = 0, y0 = 0, z0 = 0, x1 = 0, y1 = 0, z1 = 0) {
    this.min = [x0, y0, z0];
    this.max = [x1, y1, z1];
  }

  static fromEntity(x, y, z, width, height) {
    const w = width / 2;
    return new AABB(x - w, y, z - w, x + w, y + height, z + w);
  }

  clone() {
    return new AABB(this.min[0], this.min[1], this.min[2],
                    this.max[0], this.max[1], this.max[2]);
  }

  set(x0, y0, z0, x1, y1, z1) {
    this.min[0] = x0; this.min[1] = y0; this.min[2] = z0;
    this.max[0] = x1; this.max[1] = y1; this.max[2] = z1;
    return this;
  }

  copy(o) {
    return this.set(o.min[0], o.min[1], o.min[2], o.max[0], o.max[1], o.max[2]);
  }

  translate(dx, dy, dz) {
    this.min[0] += dx; this.min[1] += dy; this.min[2] += dz;
    this.max[0] += dx; this.max[1] += dy; this.max[2] += dz;
    return this;
  }

  // Translated copy (03 §8.2 edge guard probes)
  offset(dx, dy, dz) {
    return this.clone().translate(dx, dy, dz);
  }

  // Grow symmetrically (item pickup box, arrow hit inflation)
  expand(dx, dy, dz) {
    this.min[0] -= dx; this.min[1] -= dy; this.min[2] -= dz;
    this.max[0] += dx; this.max[1] += dy; this.max[2] += dz;
    return this;
  }

  // Sweep: extend one face along axis by displacement d (01 §12)
  expandByDisplacement(axis, d) {
    if (d > 0) this.max[axis] += d;
    else this.min[axis] += d;
    return this;
  }

  intersects(o) {
    return this.min[0] < o.max[0] && this.max[0] > o.min[0] &&
           this.min[1] < o.max[1] && this.max[1] > o.min[1] &&
           this.min[2] < o.max[2] && this.max[2] > o.min[2];
  }

  // Overlap with a cell-anchored box on the two axes other than `axis`.
  // Cell box = [x+bx0, x+bx1]×[y+by0, y+by1]×[z+bz0, z+bz1] (unit cube default).
  overlapsOnOtherAxes(axis, x, y, z, box = UNIT_BOX) {
    const lo = [x + box[0], y + box[1], z + box[2]];
    const hi = [x + box[3], y + box[4], z + box[5]];
    for (let a = 0; a < 3; a++) {
      if (a === axis) continue;
      if (this.max[a] <= lo[a] || this.min[a] >= hi[a]) return false;
    }
    return true;
  }

  containsPoint(x, y, z) {
    return x >= this.min[0] && x <= this.max[0] &&
           y >= this.min[1] && y <= this.max[1] &&
           z >= this.min[2] && z <= this.max[2];
  }

  center() {
    return [(this.min[0] + this.max[0]) / 2,
            (this.min[1] + this.max[1]) / 2,
            (this.min[2] + this.max[2]) / 2];
  }
}

// Local-space collision box [x0,y0,z0,x1,y1,z1] within a cell
export const UNIT_BOX = [0, 0, 0, 1, 1, 1];
