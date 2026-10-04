import { describe, it, expect } from 'vitest';
import { deg2rad } from '../../web/canvas-utils.js';

// ---------------------------------------------------------------------------
// deg2rad
// ---------------------------------------------------------------------------
describe('deg2rad', () => {
  it('converts 0° to 0 rad', () => {
    expect(deg2rad(0)).toBe(0);
  });

  it('converts 90° to π/2', () => {
    expect(deg2rad(90)).toBeCloseTo(Math.PI / 2);
  });

  it('handles negative angles', () => {
    expect(deg2rad(-90)).toBeCloseTo(-Math.PI / 2);
  });

  it('handles angles > 360', () => {
    expect(deg2rad(720)).toBeCloseTo(4 * Math.PI);
  });
});
