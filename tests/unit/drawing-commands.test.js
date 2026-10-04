/**
 * Tests for drawCommands() in canvas-runtime.js.
 *
 * The DOM (canvas + logs elements) and the canvas 2D context mock are set up
 * in tests/setup.js which runs before any module is imported.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { drawCommands, cancelNow, colorToCss, isAnimationMode, OP } from '../../web/canvas-runtime.js';

const bufferCtx = globalThis.__mockBufferCtx;
const drawCtx = globalThis.__mockDrawCtx;

function clearMocks() {
  for (const target of [bufferCtx, drawCtx]) {
    for (const v of Object.values(target)) {
      if (typeof v?.mockClear === 'function') v.mockClear();
    }
  }
}

/** Draw a flat list of opcodes and arguments. */
function draw(ops, { strings = [], present = false } = {}) {
  drawCommands(Float64Array.from(ops), strings, present);
}

const RED = 0xff0000ff;
const BLUE = 0x0000ffff;

beforeEach(() => {
  clearMocks();
  cancelNow(false);
});

// ---------------------------------------------------------------------------
// colorToCss
// ---------------------------------------------------------------------------
describe('colorToCss', () => {
  it('formats a packed color as #rrggbbaa', () => {
    expect(colorToCss(0x12345678)).toBe('#12345678');
  });

  it('pads small values', () => {
    expect(colorToCss(0x000000ff)).toBe('#000000ff');
  });

  it('handles colors with the top bit set', () => {
    expect(colorToCss(0xffffffff)).toBe('#ffffffff');
  });
});

// ---------------------------------------------------------------------------
// style
// ---------------------------------------------------------------------------
describe('drawCommands – style', () => {
  it('sets fill, stroke and line width', () => {
    draw([OP.STYLE, RED, BLUE, 3, OP.CIRCLE, 1, 2, 3]);
    expect(bufferCtx.fillStyle).toBe('#ff0000ff');
    expect(bufferCtx.strokeStyle).toBe('#0000ffff');
    expect(bufferCtx.lineWidth).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// circle
// ---------------------------------------------------------------------------
describe('drawCommands – circle', () => {
  it('draws a full circle at the given centre and radius', () => {
    draw([OP.CIRCLE, 200, 300, 50]);
    expect(bufferCtx.arc).toHaveBeenCalledOnce();
    expect(bufferCtx.arc).toHaveBeenCalledWith(200, 300, 50, 0, Math.PI * 2);
  });

  it('fills and strokes', () => {
    draw([OP.CIRCLE, 500, 500, 100]);
    expect(bufferCtx.fill).toHaveBeenCalledOnce();
    expect(bufferCtx.stroke).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// rectangle
// ---------------------------------------------------------------------------
describe('drawCommands – rectangle', () => {
  it('fills and strokes the rectangle between two corners', () => {
    draw([OP.RECTANGLE, 100, 150, 300, 400]);
    expect(bufferCtx.fillRect).toHaveBeenCalledWith(100, 150, 200, 250);
    expect(bufferCtx.strokeRect).toHaveBeenCalledWith(100, 150, 200, 250);
  });
});

// ---------------------------------------------------------------------------
// line
// ---------------------------------------------------------------------------
describe('drawCommands – line', () => {
  it('strokes a line between the two points without filling', () => {
    draw([OP.LINE, 10, 20, 30, 40]);
    expect(bufferCtx.moveTo).toHaveBeenCalledWith(10, 20);
    expect(bufferCtx.lineTo).toHaveBeenCalledWith(30, 40);
    expect(bufferCtx.stroke).toHaveBeenCalledOnce();
    expect(bufferCtx.fill).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// arc
// ---------------------------------------------------------------------------
describe('drawCommands – arc', () => {
  it('converts start and end angles from degrees to radians', () => {
    draw([OP.ARC, 500, 400, 100, 0, 90]);
    const [cx, cy, r, a0, a1] = bufferCtx.arc.mock.calls[0];
    expect([cx, cy, r]).toEqual([500, 400, 100]);
    expect(a0).toBe(0);
    expect(a1).toBeCloseTo(Math.PI / 2);
  });

  it('fills and strokes', () => {
    draw([OP.ARC, 500, 500, 100, 0, 180]);
    expect(bufferCtx.fill).toHaveBeenCalledOnce();
    expect(bufferCtx.stroke).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// polygon
// ---------------------------------------------------------------------------
describe('drawCommands – polygon', () => {
  it('moves to the first point and draws lines to the others', () => {
    draw([OP.POLYGON, 6, 0, 0, 100, 0, 50, 80]);
    expect(bufferCtx.moveTo).toHaveBeenCalledWith(0, 0);
    expect(bufferCtx.lineTo.mock.calls).toEqual([[100, 0], [50, 80]]);
    expect(bufferCtx.closePath).toHaveBeenCalled();
    expect(bufferCtx.fill).toHaveBeenCalledOnce();
    expect(bufferCtx.stroke).toHaveBeenCalledOnce();
  });

  it('continues with the next operation after the polygon', () => {
    draw([OP.POLYGON, 6, 0, 0, 100, 0, 50, 80, OP.CIRCLE, 1, 2, 3]);
    expect(bufferCtx.arc).toHaveBeenCalledWith(1, 2, 3, 0, Math.PI * 2);
  });
});

// ---------------------------------------------------------------------------
// clear
// ---------------------------------------------------------------------------
describe('drawCommands – clear', () => {
  it('clears and refills the canvas with the background color', () => {
    draw([OP.CLEAR]);
    expect(bufferCtx.clearRect).toHaveBeenCalled();
    expect(bufferCtx.fillRect).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// print
// ---------------------------------------------------------------------------
describe('drawCommands – print', () => {
  it('logs the referenced message to the console', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    draw([OP.PRINT, 1], { strings: ['first', 'hello world'] });
    expect(spy).toHaveBeenCalledWith('Print:hello world');
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// multiple operations / unknown opcodes / cancellation
// ---------------------------------------------------------------------------
describe('drawCommands – sequencing', () => {
  it('runs operations in order', () => {
    draw([OP.CIRCLE, 1, 2, 3, OP.LINE, 4, 5, 6, 7, OP.CIRCLE, 8, 9, 10]);
    expect(bufferCtx.arc.mock.calls.map(c => c.slice(0, 3))).toEqual([[1, 2, 3], [8, 9, 10]]);
    expect(bufferCtx.moveTo).toHaveBeenCalledWith(4, 5);
  });

  it('stops at an unknown opcode instead of misreading arguments', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    draw([99, OP.CIRCLE, 1, 2, 3]);
    expect(bufferCtx.arc).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('draws nothing when cancelled', () => {
    cancelNow();
    draw([OP.CIRCLE, 1, 2, 3]);
    expect(bufferCtx.arc).not.toHaveBeenCalled();
    expect(drawCtx.drawImage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// compositing (drawImage)
// ---------------------------------------------------------------------------
describe('drawCommands – compositing', () => {
  it('draws to the buffer, then composites to the visible canvas', () => {
    draw([OP.CIRCLE, 500, 500, 100]);
    expect(bufferCtx.arc).toHaveBeenCalled();
    expect(drawCtx.arc).not.toHaveBeenCalled();
    expect(drawCtx.drawImage).toHaveBeenCalledWith(expect.any(HTMLCanvasElement), 0, 0);
  });

  it('enters animation mode on ANIMATE', () => {
    expect(isAnimationMode()).toBe(false);
    draw([OP.ANIMATE]);
    expect(isAnimationMode()).toBe(true);
  });

  it('skips compositing in animation mode unless presenting', () => {
    draw([OP.ANIMATE, OP.CIRCLE, 500, 500, 100]);
    expect(drawCtx.drawImage).not.toHaveBeenCalled();
  });

  it('composites in animation mode when presenting a frame', () => {
    draw([OP.ANIMATE]);
    draw([OP.CIRCLE, 500, 500, 100], { present: true });
    expect(drawCtx.drawImage).toHaveBeenCalled();
  });

  it('presents an empty frame', () => {
    draw([OP.ANIMATE]);
    draw([], { present: true });
    expect(drawCtx.drawImage).toHaveBeenCalled();
  });
});
