// frame.mjs — the one local metric frame shared by every bake stage.
//
// Axes: +X east, +Z south, +Y up (meters ASL). One world unit = one meter.
//
// The frame origin is the NORTH-WEST corner of the padded bbox (design.md §3):
// with +Z pointing south, anchoring at the north edge keeps every coordinate
// inside the box positive and makes heightmap row 0 = the northern edge, rows
// increasing southward — the same direction z grows.

export const M_PER_DEG_LAT = 111_320;

/**
 * @param {{minLat:number,minLon:number,maxLat:number,maxLon:number}} bbox padded bbox
 */
export function makeFrame(bbox) {
  const lat0 = (bbox.minLat + bbox.maxLat) / 2;
  const cosLat0 = Math.cos((lat0 * Math.PI) / 180);
  const originLat = bbox.maxLat; // north edge
  const originLon = bbox.minLon; // west edge
  const widthM = (bbox.maxLon - bbox.minLon) * M_PER_DEG_LAT * cosLat0;
  const heightM = (bbox.maxLat - bbox.minLat) * M_PER_DEG_LAT;

  return {
    bbox,
    lat0,
    cosLat0,
    originLat,
    originLon,
    widthM,
    heightM,
    /** lat/lon → local meters {x east, z south} */
    toLocal(lat, lon) {
      return {
        x: (lon - originLon) * M_PER_DEG_LAT * cosLat0,
        z: (originLat - lat) * M_PER_DEG_LAT,
      };
    },
    /** local meters → lat/lon */
    toLatLon(x, z) {
      return {
        lat: originLat - z / M_PER_DEG_LAT,
        lon: originLon + x / (M_PER_DEG_LAT * cosLat0),
      };
    },
  };
}
