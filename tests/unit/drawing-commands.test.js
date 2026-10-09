/**
 * Tests for drawCommands() in canvas-runtime.js.
 *
 * The DOM (canvas + logs elements) and the canvas 2D context mock are set up
 * in tests/setup.js which runs before any module is imported.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { drawCommands, setup, cancelNow, colorToCss, isAnimationMode, setPrintHandler, setPresentHandler, OP } from '../../web/canvas-runtime.js';

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
  it('logs the referenced text to the browser console by default', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    draw([OP.PRINT, 1], { strings: ['first', 'hello world'] });
    expect(spy).toHaveBeenCalledWith('hello world');
    spy.mockRestore();
  });

  it('passes each text to the print handler in order', () => {
    const printed = [];
    setPrintHandler(text => printed.push(text));
    draw([OP.PRINT, 0, OP.CIRCLE, 1, 2, 3, OP.PRINT, 1], { strings: ['a', 'b'] });
    expect(printed).toEqual(['a', 'b']);
    setPrintHandler(text => console.log(text));
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

// ---------------------------------------------------------------------------
// Present handler
// ---------------------------------------------------------------------------
describe('setPresentHandler', () => {
  const visible = document.getElementById('canvas');
  let shown;

  beforeEach(() => {
    shown = vi.fn();
    setPresentHandler(shown);
  });
  afterEach(() => setPresentHandler(() => {}));

  it('is told about each picture shown outside animation mode', () => {
    draw([OP.CLEAR]);
    expect(shown).toHaveBeenCalledWith(visible);
  });

  it('is told only about presented frames in animation mode', () => {
    draw([OP.ANIMATE]);
    draw([OP.CLEAR]);
    expect(shown).not.toHaveBeenCalled();
    draw([OP.CLEAR], { present: true });
    expect(shown).toHaveBeenCalledTimes(1);
  });

  it('is not told anything after the run is cancelled', () => {
    cancelNow();
    draw([OP.CLEAR]);
    expect(shown).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Bad shapes must not lose the rest of the batch
// ---------------------------------------------------------------------------
describe('drawCommands – survives a bad shape', () => {
  beforeEach(() => { setup(); clearMocks(); });
  afterEach(() => {
    bufferCtx.arc.mockReset();
    vi.restoreAllMocks();
    setPrintHandler((text) => console.log(text));
  });

  it('skips a circle with a negative radius', () => {
    draw([OP.CIRCLE, 100, 100, -5]);
    expect(bufferCtx.arc).not.toHaveBeenCalled();
    expect(bufferCtx.fill).not.toHaveBeenCalled();
  });

  it('skips an arc with a negative radius', () => {
    draw([OP.ARC, 100, 100, -5, 0, 90]);
    expect(bufferCtx.arc).not.toHaveBeenCalled();
  });

  it('keeps drawing and printing after a negative-radius circle', () => {
    const printed = vi.fn();
    setPrintHandler(printed);
    draw([OP.CIRCLE, 1, 1, -1, OP.RECTANGLE, 0, 0, 10, 10, OP.PRINT, 0], { strings: ['after'] });
    expect(bufferCtx.fillRect).toHaveBeenCalledOnce();
    expect(printed).toHaveBeenCalledWith('after');
  });

  it('keeps going when an operation throws, and warns once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const printed = vi.fn();
    setPrintHandler(printed);
    bufferCtx.arc.mockImplementation(() => { throw new DOMException('bad', 'IndexSizeError'); });
    draw([
      OP.CIRCLE, 1, 1, 5,
      OP.CIRCLE, 2, 2, 5,
      OP.RECTANGLE, 0, 0, 10, 10,
      OP.PRINT, 0,
    ], { strings: ['still here'] });
    expect(bufferCtx.fillRect).toHaveBeenCalledOnce();
    expect(printed).toHaveBeenCalledWith('still here');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('balances save and restore even when an operation throws', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    bufferCtx.arc.mockImplementation(() => { throw new Error('boom'); });
    draw([OP.CIRCLE, 1, 1, 5]);
    expect(bufferCtx.restore.mock.calls.length).toBe(bufferCtx.save.mock.calls.length);
  });

  it('still shows the picture after a throwing operation', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    bufferCtx.arc.mockImplementation(() => { throw new Error('boom'); });
    draw([OP.CIRCLE, 1, 1, 5]);
    expect(drawCtx.drawImage).toHaveBeenCalled();
  });
});
