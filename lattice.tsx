import React, {useEffect, useMemo, useRef, useState} from "react";

// --- Types ---------------------------------------------------------------

type EdgeKind = "X" | "Z";

type PatchId = string;

type Rect = { x: number; y: number; w: number; h: number }; // in tile units

type Patch = {
  id: PatchId;
  rect: Rect;
  // edge types per face (Litinski tile game: each boundary is X or Z)
  edges: { top: EdgeKind; right: EdgeKind; bottom: EdgeKind; left: EdgeKind };
  label?: string;
};

type Action =
  | { kind: "InitPatch"; patch: Patch }
  | { kind: "DeformTo"; id: PatchId; to: Rect; tickCost?: 1 | 0 }
  | { kind: "MoveTo"; id: PatchId; to: { x: number; y: number }; tickCost?: 1 | 0 }
  | { kind: "TwoPatchMeas"; lhs: { id: PatchId; edge: keyof Patch["edges"] }; rhs: { id: PatchId; edge: keyof Patch["edges"] }; outcome?: 1 | -1 }
  | { kind: "SinglePatchMeas"; id: PatchId; basis: EdgeKind; outcome?: 1 | -1 }
  | { kind: "RotateEdges"; id: PatchId; // rotate boundary types 90° CW
      }
  | { kind: "Discard"; id: PatchId };

type Step = { actions: Action[]; label?: string };

// Program format the TextArea expects
// { tickMs: 500, grid: {cols: 26, rows: 16}, steps: Step[] }

type Program = {
  tickMs: number;
  grid: { cols: number; rows: number };
  steps: Step[];
};

// --- Utility -------------------------------------------------------------

const TILE = 40; // px per tile

function deepCopy<T>(x: T): T { return JSON.parse(JSON.stringify(x)); }

function clamp01(x: number) { return Math.min(1, Math.max(0, x)); }

function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }

function lerpRect(a: Rect, b: Rect, t: number): Rect {
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), w: lerp(a.w, b.w, t), h: lerp(a.h, b.h, t) };
}

// compute the center of a given edge for a patch rect
function edgeMidpoint(rect: Rect, edge: keyof Patch["edges"]) {
  const x = rect.x, y = rect.y, w = rect.w, h = rect.h;
  switch (edge) {
    case "top": return { x: x + w / 2, y };
    case "bottom": return { x: x + w / 2, y: y + h };
    case "left": return { x, y: y + h / 2 };
    case "right": return { x: x + w, y: y + h / 2 };
  }
}

// --- Rendering -----------------------------------------------------------

function drawGrid(ctx: CanvasRenderingContext2D, cols: number, rows: number) {
  ctx.save();
  ctx.strokeStyle = "#e7e7e7";
  ctx.lineWidth = 1;
  for (let c = 0; c <= cols; c++) {
    ctx.beginPath();
    ctx.moveTo(c * TILE + 0.5, 0);
    ctx.lineTo(c * TILE + 0.5, rows * TILE);
    ctx.stroke();
  }
  for (let r = 0; r <= rows; r++) {
    ctx.beginPath();
    ctx.moveTo(0, r * TILE + 0.5);
    ctx.lineTo(cols * TILE, r * TILE + 0.5);
    ctx.stroke();
  }
  ctx.restore();
}

function drawDashedLine(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number) {
  ctx.save();
  ctx.setLineDash([6, 6]);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.restore();
}

function drawPatch(ctx: CanvasRenderingContext2D, p: Patch) {
  const { x, y, w, h } = p.rect;
  const px = x * TILE, py = y * TILE, pw = w * TILE, ph = h * TILE;

  // body
  ctx.save();
  ctx.fillStyle = "#f4e5c3"; // soft parchment
  ctx.strokeStyle = "#222";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.rect(px, py, pw, ph);
  ctx.fill();
  ctx.stroke();

  // edges: solid for Z, dashed for X
  ctx.lineWidth = 4;
  // top
  if (p.edges.top === "X") drawDashedLine(ctx, px, py, px + pw, py); else { ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + pw, py); ctx.stroke(); }
  // right
  if (p.edges.right === "X") drawDashedLine(ctx, px + pw, py, px + pw, py + ph); else { ctx.beginPath(); ctx.moveTo(px + pw, py); ctx.lineTo(px + pw, py + ph); ctx.stroke(); }
  // bottom
  if (p.edges.bottom === "X") drawDashedLine(ctx, px, py + ph, px + pw, py + ph); else { ctx.beginPath(); ctx.moveTo(px, py + ph); ctx.lineTo(px + pw, py + ph); ctx.stroke(); }
  // left
  if (p.edges.left === "X") drawDashedLine(ctx, px, py, px, py + ph); else { ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px, py + ph); ctx.stroke(); }

  // label
  ctx.fillStyle = "#222";
  ctx.font = "16px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(p.label ?? p.id, px + pw / 2, py + ph / 2);
  ctx.restore();
}

function drawTwoPatchMeas(ctx: CanvasRenderingContext2D, a: Patch, aEdge: keyof Patch["edges"], b: Patch, bEdge: keyof Patch["edges"], progress: number, outcome?: 1 | -1) {
  // Connect edge midpoints, thicken as it "activates"
  const A = edgeMidpoint(a.rect, aEdge);
  const B = edgeMidpoint(b.rect, bEdge);
  const ax = A.x * TILE, ay = A.y * TILE, bx = B.x * TILE, by = B.y * TILE;

  ctx.save();
  ctx.lineWidth = lerp(2, 10, progress);
  ctx.strokeStyle = outcome === -1 ? "#c62828" : outcome === 1 ? "#2e7d32" : "#1976d2";
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(bx, by);
  ctx.stroke();

  // outcome dot in the middle
  const mx = (ax + bx) / 2, my = (ay + by) / 2;
  ctx.beginPath();
  ctx.arc(mx, my, 6 + 8 * progress, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

// --- Engine --------------------------------------------------------------

type RuntimePatch = Patch & { _animFrom?: Rect; _animTo?: Rect; };

type RuntimeState = {
  patches: Map<PatchId, RuntimePatch>;
  measurementOverlay?: {
    a: RuntimePatch; aEdge: keyof Patch["edges"]; b: RuntimePatch; bEdge: keyof Patch["edges"]; outcome?: 1|-1; progress: number;
  };
};

function cloneRuntimeState(s: RuntimeState): RuntimeState {
  const m = new Map<PatchId, RuntimePatch>();
  s.patches.forEach((p, k) => m.set(k, deepCopy(p)));
  return { patches: m, measurementOverlay: s.measurementOverlay ? { ...s.measurementOverlay } : undefined };
}

// Apply actions at the **end** of a tick (i.e., commit target rectangles)
function commitActions(state: RuntimeState, actions: Action[]) {
  for (const act of actions) {
    switch (act.kind) {
      case "InitPatch": {
        state.patches.set(act.patch.id, deepCopy(act.patch));
        break;
      }
      case "DeformTo": {
        const p = state.patches.get(act.id);
        if (!p) break;
        p.rect = deepCopy(act.to);
        p._animFrom = undefined; p._animTo = undefined;
        break;
      }
      case "MoveTo": {
        const p = state.patches.get(act.id); if (!p) break;
        p.rect.x = act.to.x; p.rect.y = act.to.y;
        p._animFrom = undefined; p._animTo = undefined;
        break;
      }
      case "RotateEdges": {
        const p = state.patches.get(act.id); if (!p) break;
        const e = p.edges; p.edges = { top: e.left, right: e.top, bottom: e.right, left: e.bottom };
        break;
      }
      case "Discard": {
        state.patches.delete(act.id); break;
      }
      case "SinglePatchMeas": {
        // simple flash handled by overlay on the next frame; after commit we keep the patch
        break;
      }
      case "TwoPatchMeas": {
        // overlay disappears on commit
        state.measurementOverlay = undefined; break;
      }
    }
  }
}

// Prepare per-tick animation metadata (from -> to rects) before ticking
function prepareTick(state: RuntimeState, actions: Action[]) {
  // reset overlay
  state.measurementOverlay = undefined;

  for (const act of actions) {
    switch (act.kind) {
      case "DeformTo": {
        const p = state.patches.get(act.id); if (!p) break;
        p._animFrom = deepCopy(p.rect);
        p._animTo = deepCopy(act.to);
        break;
      }
      case "MoveTo": {
        const p = state.patches.get(act.id); if (!p) break;
        p._animFrom = deepCopy(p.rect);
        p._animTo = { ...p.rect, x: act.to.x, y: act.to.y };
        break;
      }
      case "TwoPatchMeas": {
        const a = state.patches.get(act.lhs.id);
        const b = state.patches.get(act.rhs.id);
        if (a && b) state.measurementOverlay = { a, aEdge: act.lhs.edge, b, bEdge: act.rhs.edge, outcome: act.outcome, progress: 0 };
        break;
      }
      case "SinglePatchMeas": {
        const p = state.patches.get(act.id);
        if (p) {
          // briefly shrink-expand or halo; handled at draw time using basis/outcome coloring
          // For MVP we won’t animate this further.
        }
        break;
      }
    }
  }
}

function drawRuntime(ctx: CanvasRenderingContext2D, runtime: RuntimeState, grid: {cols:number; rows:number}) {
  ctx.clearRect(0, 0, grid.cols * TILE, grid.rows * TILE);
  drawGrid(ctx, grid.cols, grid.rows);
  // draw patches
  for (const p of runtime.patches.values()) drawPatch(ctx, p);
  // overlay
  if (runtime.measurementOverlay) {
    const { a, aEdge, b, bEdge, outcome, progress } = runtime.measurementOverlay;
    drawTwoPatchMeas(ctx, a, aEdge, b, bEdge, progress, outcome);
  }
}

function advanceInterpolations(runtime: RuntimeState, t01: number) {
  for (const p of runtime.patches.values()) {
    if (p._animFrom && p._animTo) {
      p.rect = lerpRect(p._animFrom, p._animTo, t01);
    }
  }
  if (runtime.measurementOverlay) runtime.measurementOverlay.progress = t01;
}

// --- Component -----------------------------------------------------------

const demoProgram: Program = {
  tickMs: 700,
  grid: { cols: 26, rows: 16 },
  steps: [
    { label: "init", actions: [
      { kind: "InitPatch", patch: { id: "q0", label: "q0", rect: { x: 6, y: 7, w: 3, h: 3 }, edges: { top: "Z", right: "X", bottom: "Z", left: "X" } } },
      { kind: "InitPatch", patch: { id: "q1", label: "q1", rect: { x: 16, y: 7, w: 3, h: 3 }, edges: { top: "Z", right: "X", bottom: "Z", left: "X" } } },
    ]},
    { label: "approach", actions: [
      { kind: "DeformTo", id: "q0", to: { x: 8, y: 7, w: 4, h: 3 } },
      { kind: "DeformTo", id: "q1", to: { x: 14, y: 7, w: 4, h: 3 } },
    ]},
    { label: "Z Z measurement", actions: [
      { kind: "TwoPatchMeas", lhs: { id: "q0", edge: "right" }, rhs: { id: "q1", edge: "left" }, outcome: 1 },
    ]},
    { label: "separate", actions: [
      { kind: "DeformTo", id: "q0", to: { x: 6, y: 7, w: 3, h: 3 } },
      { kind: "DeformTo", id: "q1", to: { x: 16, y: 7, w: 3, h: 3 } },
    ]},
    { label: "rotate edges", actions: [ { kind: "RotateEdges", id: "q0" }, { kind: "RotateEdges", id: "q1" } ] },
    { label: "X X measurement", actions: [
      { kind: "TwoPatchMeas", lhs: { id: "q0", edge: "bottom" }, rhs: { id: "q1", edge: "bottom" }, outcome: -1 },
    ]},
  ],
};

function useAnimationClock(running: boolean, tickMs: number, onTick: (dtMs: number) => void) {
  const last = useRef<number | null>(null);
  useEffect(() => {
    let raf = 0;
    const loop = (t: number) => {
      if (last.current == null) last.current = t;
      const dt = t - last.current; last.current = t;
      if (running) onTick(dt);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [running, tickMs, onTick]);
}

export default function LatticeSurgeryVisualizer() {
  // program state
  const [programText, setProgramText] = useState<string>(JSON.stringify(demoProgram, null, 2));
  const [parseError, setParseError] = useState<string | null>(null);
  const program: Program | null = useMemo(() => {
    try {
      const p = JSON.parse(programText) as Program;
      setParseError(null);
      return p;
    } catch (e: any) {
      setParseError(e.message);
      return null;
    }
  }, [programText]);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // runtime machine
  const [runtime, setRuntime] = useState<RuntimeState>(() => ({ patches: new Map() }));
  const [stepIdx, setStepIdx] = useState(0);
  const [tInStep, setTInStep] = useState(0); // ms progressed inside the current tick
  const [playing, setPlaying] = useState(false);

  // initialize / reset when program changes
  useEffect(() => {
    if (!program) return;
    setRuntime({ patches: new Map() });
    setStepIdx(0);
    setTInStep(0);
    setPlaying(false);
  }, [programText]);

  // render loop
  useAnimationClock(true, program?.tickMs ?? 700, (dt) => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx || !program) return;

    // advance animation if playing
    let newRuntime = cloneRuntimeState(runtime);
    let newStepIdx = stepIdx;
    let newT = tInStep;

    if (playing && program.steps.length > 0) {
      const step = program.steps[newStepIdx];
      // prepare animation at the start of a step
      if (newT === 0) {
        newRuntime = cloneRuntimeState(runtime);
        prepareTick(newRuntime, step.actions);
      }

      newT += dt;
      const t01 = clamp01(newT / program.tickMs);
      advanceInterpolations(newRuntime, t01);

      if (newT >= program.tickMs) {
        // commit and advance step
        commitActions(newRuntime, step.actions);
        newStepIdx = Math.min(program.steps.length - 1, newStepIdx + 1);
        newT = 0;
      }
    }

    // draw
    drawRuntime(ctx, newRuntime, program.grid);
    setRuntime(newRuntime);
    setStepIdx(newStepIdx);
    setTInStep(newT);
  });

  const w = (program?.grid.cols ?? 26) * TILE;
  const h = (program?.grid.rows ?? 16) * TILE;

  // controls
  const stepOnce = () => {
    if (!program) return;
    const idx = Math.min(stepIdx, program.steps.length - 1);
    const st = program.steps[idx];
    const rt = cloneRuntimeState(runtime);
    prepareTick(rt, st.actions);
    advanceInterpolations(rt, 1);
    commitActions(rt, st.actions);
    setRuntime(rt);
    setStepIdx(Math.min(idx + 1, program.steps.length - 1));
    setTInStep(0);
  };

  const reset = () => {
    setRuntime({ patches: new Map() });
    setStepIdx(0);
    setTInStep(0);
    setPlaying(false);
  };

  return (
    <div className="w-full h-full flex items-stretch gap-4 p-4">
      {/* Animation Area */}
      <div className="flex-1">
        <div className="flex items-center justify-between mb-2">
          <div className="font-semibold text-lg">Lattice Surgery – Animation</div>
          <div className="flex items-center gap-2">
            <button
              className="px-3 py-1 rounded-2xl bg-neutral-200 hover:bg-neutral-300"
              onClick={(): void => setPlaying((p: boolean): boolean => !p)}
            >
              {playing ? "Pause" : "Play"}
            </button>
            <button className="px-3 py-1 rounded-2xl bg-neutral-200 hover:bg-neutral-300" onClick={stepOnce}>Step</button>
            <button className="px-3 py-1 rounded-2xl bg-neutral-200 hover:bg-neutral-300" onClick={reset}>Reset</button>
            <div className="text-sm text-neutral-600">step {stepIdx + 1}/{program?.steps.length ?? 0}</div>
          </div>
        </div>
        <canvas ref={canvasRef} width={w} height={h} className="rounded-2xl shadow border border-neutral-300" />
        <div className="mt-2 text-sm text-neutral-600">Grid: {program?.grid.cols}×{program?.grid.rows} • Tick: {program?.tickMs} ms</div>
      </div>

      {/* Instruction / Program Area */}
      <div className="w-[520px] shrink-0">
        <div className="font-semibold text-lg mb-2">Program (JSON)</div>
        <textarea
          className={`w-full h-[560px] p-3 rounded-2xl shadow border font-mono text-sm ${parseError ? 'border-red-500' : 'border-neutral-300'}`}
          spellCheck={false}
          value={programText}
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>): void => setProgramText(e.target.value)}
        />
        {parseError ? (
          <div className="mt-2 text-red-600 text-sm">Parse error: {parseError}</div>
        ) : (
          <div className="mt-2 text-neutral-600 text-sm">
            Edit the JSON and press <b>Play</b> or <b>Step</b>. Actions supported: <code>InitPatch</code>, <code>DeformTo</code>, <code>MoveTo</code>, <code>RotateEdges</code>, <code>TwoPatchMeas</code>, <code>SinglePatchMeas</code>, <code>Discard</code>.
          </div>
        )}
      </div>
    </div>
  );
}
