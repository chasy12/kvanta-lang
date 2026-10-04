// Pure utility functions extracted from canvas-runtime.js.
// No DOM dependencies — safe to import in unit tests.

/** Default canvas width in pixels. */
export const CANVAS_W = 1000;

/** Default canvas height in pixels. */
export const CANVAS_H = 1000;

/**
 * Converts degrees to radians.
 * @param {number} d - Angle in degrees.
 * @returns {number} Angle in radians.
 */
export const deg2rad = d => (d * Math.PI) / 180;
