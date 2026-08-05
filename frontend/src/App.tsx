import type * as THREE from "three";
import { useEffect, useRef, useState } from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount, useWalletClient } from "wagmi";
import {
  submitBracket,
  auditSeed,
  evaluateFairness,
  ratify,
  resubmitDraw,
  retireBracket,
  getBracketCard,
  getAnomalies,
  getStats,
  getFairnessBands,
  getRulingDistribution,
  getPhaseDistribution,
  topTournaments,
  listAnomalyKinds,
  listBracketsBySubmitter,
  type BracketCard,
  type AnomalyItem,
  type Stats,
  type FairnessBands,
} from "./contractService";
import { CONTRACT_ADDRESS, GENLAYER_CHAIN_ID, GENLAYER_EXPLORER_URL } from "./chain";

type Hex = `0x${string}`;
type Busy = null | "submit" | "audit" | "evaluate" | "ratify" | "resubmit" | "retire" | "load";

type RulingKey = "FAIR" | "CONTESTED" | "RIGGED" | "PENDING";
const RULING_ORDER: RulingKey[] = ["FAIR", "CONTESTED", "RIGGED", "PENDING"];
const PHASE_ORDER = ["SUBMITTED", "AUDITED", "EVALUATED", "RATIFIED", "REDRAW", "RETIRED"];

interface TopTournament {
  tournament: string;
  tournamentHash: string;
  brackets: number;
  rigged: number;
  score: number;
}
interface AnomalyKindRow {
  kindId: number;
  name: string;
  severity: number;
}
interface SubmitterBracket {
  bracketId: number;
  tournament: string;
  status: string;
  ruling: string;
}

function toNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function sevClass(sev: number): string {
  if (sev >= 4) return "crit";
  if (sev === 3) return "hi";
  if (sev === 2) return "mid";
  return "lo";
}

function WalletControl() {
  return (
    <ConnectButton.Custom>
      {({ account, chain, openAccountModal, openChainModal, openConnectModal, mounted }) => {
        const connected = mounted && account && chain;
        if (!connected)
          return (
            <button className="wbtn" onClick={openConnectModal} type="button">
              Connect Wallet
            </button>
          );
        if (chain?.unsupported)
          return (
            <button className="wbtn wbtn-warn" onClick={openChainModal} type="button">
              Wrong network
            </button>
          );
        return (
          <button className="wchip" onClick={openAccountModal} type="button">
            <span className="wdot" />
            {account.displayName}
          </button>
        );
      }}
    </ConnectButton.Custom>
  );
}

const DISCIPLINES = ["Chess", "Tennis", "Esports", "Boxing", "Debate", "Football"];
const SIZES = [8, 16, 32, 64];

/* Bespoke three.js scene: a 3D single-elimination bracket built as a binary
   tree of wireframe node-cubes joined by edges. A pulse of light advances from
   the leaves up toward the champion node. GSAP drives the advancing pulse,
   the node lights and the parallax. Hero-scoped, lazy, fully disposed. */
function useBracketScene(ref: React.RefObject<HTMLDivElement>) {
  useEffect(() => {
    if (!ref.current) return;
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let cancelled = false;
    let cleanup: (() => void) | null = null;

    (async () => {
      try {
        const THREEmod = await import("three");
        const { gsap } = await import("gsap");
        if (cancelled || !ref.current) return;
        const el = ref.current;
        const W = () => el.clientWidth || 1;
        const H = () => el.clientHeight || 1;

        const renderer = new THREEmod.WebGLRenderer({ alpha: true, antialias: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.setSize(W(), H());
        const cv = renderer.domElement;
        cv.style.position = "absolute";
        cv.style.inset = "0";
        cv.style.width = "100%";
        cv.style.height = "100%";
        cv.style.zIndex = "0";
        cv.style.pointerEvents = "none";
        el.appendChild(cv);

        const scene = new THREEmod.Scene();
        const camera = new THREEmod.PerspectiveCamera(50, W() / H(), 0.1, 100);
        camera.position.set(0, 0, 12.5);
        camera.lookAt(0, 0, 0);

        const group = new THREEmod.Group();
        scene.add(group);

        const green = new THREEmod.Color(0x3ddc84);
        const steel = new THREEmod.Color(0x274033);
        const gold = new THREEmod.Color(0xe8c14a);

        const LEVELS = 4; // 8 -> 4 -> 2 -> 1
        const leafCount = 1 << (LEVELS - 1);
        const spread = 12.5;

        type Node = {
          mesh: THREE.Mesh;
          mat: THREE.MeshBasicMaterial;
          base: THREE.Color;
          lit: THREE.Color;
          level: number;
          pos: THREE.Vector3;
          champ: boolean;
        };

        const cubeGeo = new THREEmod.BoxGeometry(0.5, 0.5, 0.5);
        const nodes: Node[] = [];
        const byLevel: Node[][] = [];

        for (let L = 0; L < LEVELS; L++) {
          const count = leafCount >> L;
          const y = -3.3 + L * 2.2;
          const arr: Node[] = [];
          for (let i = 0; i < count; i++) {
            let x: number;
            if (L === 0) {
              x = (i - (count - 1) / 2) * (spread / (leafCount - 1));
            } else {
              const a = byLevel[L - 1][i * 2].pos.x;
              const b = byLevel[L - 1][i * 2 + 1].pos.x;
              x = (a + b) / 2;
            }
            const z = i % 2 === 0 ? 0.35 : -0.35;
            const champ = L === LEVELS - 1;
            const base = champ ? gold.clone() : steel.clone();
            const lit = champ ? gold.clone() : green.clone();
            const mat = new THREEmod.MeshBasicMaterial({
              color: base.clone(),
              wireframe: true,
              transparent: true,
              opacity: 0.55,
            });
            const mesh = new THREEmod.Mesh(cubeGeo, mat);
            const sc = champ ? 1.5 : 1 - L * 0.08;
            mesh.position.set(x, y, z);
            mesh.scale.setScalar(sc);
            group.add(mesh);
            const node: Node = { mesh, mat, base, lit, level: L, pos: mesh.position.clone(), champ };
            arr.push(node);
            nodes.push(node);
          }
          byLevel.push(arr);
        }

        type Edge = { child: THREE.Vector3; parent: THREE.Vector3; level: number };
        const edges: Edge[] = [];
        const edgePts: number[] = [];
        for (let L = 1; L < LEVELS; L++) {
          for (let i = 0; i < byLevel[L].length; i++) {
            const parent = byLevel[L][i];
            const c1 = byLevel[L - 1][i * 2];
            const c2 = byLevel[L - 1][i * 2 + 1];
            for (const c of [c1, c2]) {
              edges.push({ child: c.pos.clone(), parent: parent.pos.clone(), level: L - 1 });
              edgePts.push(c.pos.x, c.pos.y, c.pos.z, parent.pos.x, parent.pos.y, parent.pos.z);
            }
          }
        }
        const edgeGeo = new THREEmod.BufferGeometry();
        edgeGeo.setAttribute("position", new THREEmod.Float32BufferAttribute(edgePts, 3));
        const edgeMat = new THREEmod.LineBasicMaterial({ color: 0x4a5f3a, transparent: true, opacity: 0.4 });
        const edgeLines = new THREEmod.LineSegments(edgeGeo, edgeMat);
        group.add(edgeLines);

        const pulsePos = new Float32Array(edges.length * 3);
        for (let k = 0; k < edges.length; k++) {
          pulsePos[k * 3] = edges[k].child.x;
          pulsePos[k * 3 + 1] = edges[k].child.y;
          pulsePos[k * 3 + 2] = edges[k].child.z;
        }
        const pulseGeo = new THREEmod.BufferGeometry();
        pulseGeo.setAttribute("position", new THREEmod.BufferAttribute(pulsePos, 3));
        const pulseMat = new THREEmod.PointsMaterial({ color: 0xfff0b8, size: 0.32, transparent: true, opacity: 0.95 });
        const pulses = new THREEmod.Points(pulseGeo, pulseMat);
        group.add(pulses);

        const dustGeo = new THREEmod.BufferGeometry();
        const M = 150;
        const dp = new Float32Array(M * 3);
        for (let i = 0; i < M; i++) {
          dp[i * 3] = (Math.random() - 0.5) * 30;
          dp[i * 3 + 1] = (Math.random() - 0.5) * 18;
          dp[i * 3 + 2] = -7 - Math.random() * 16;
        }
        dustGeo.setAttribute("position", new THREEmod.BufferAttribute(dp, 3));
        const dust = new THREEmod.Points(
          dustGeo,
          new THREEmod.PointsMaterial({ color: 0x3a4a2e, size: 0.05, transparent: true, opacity: 0.5 })
        );
        scene.add(dust);

        const smooth = THREEmod.MathUtils.smoothstep;
        const mouse = { x: 0, y: 0 };
        const stateProg = { prog: 0 };

        const paint = () => {
          const prog = stateProg.prog;
          for (const n of nodes) {
            const lit = smooth(prog - n.level, -0.2, 0.4);
            n.mat.color.copy(n.base).lerp(n.lit, lit);
            n.mat.opacity = 0.5 + 0.45 * lit;
            const champBoost = n.champ ? 0.5 : 0.18;
            const baseScale = n.champ ? 1.5 : 1 - n.level * 0.08;
            n.mesh.scale.setScalar(baseScale * (1 + champBoost * lit));
            n.mesh.rotation.y += 0.004 + 0.01 * lit;
          }
          const pos = pulseGeo.getAttribute("position") as any;
          for (let k = 0; k < edges.length; k++) {
            const e = edges[k];
            const t = Math.min(Math.max(prog - e.level, 0), 1);
            const active = prog >= e.level - 0.05 && prog <= e.level + 1.05;
            const px = e.child.x + (e.parent.x - e.child.x) * t;
            const py = e.child.y + (e.parent.y - e.child.y) * t;
            const pz = e.child.z + (e.parent.z - e.child.z) * t;
            pos.array[k * 3] = px;
            pos.array[k * 3 + 1] = active ? py : -200;
            pos.array[k * 3 + 2] = pz;
          }
          pos.needsUpdate = true;
        };

        const render = () => {
          dust.rotation.z += 0.0003;
          group.rotation.y += (mouse.x * 0.4 - group.rotation.y) * 0.05;
          group.rotation.x += (-mouse.y * 0.22 - group.rotation.x) * 0.05;
          renderer.render(scene, camera);
        };
        const onResize = () => {
          camera.aspect = W() / H();
          camera.updateProjectionMatrix();
          renderer.setSize(W(), H());
        };
        const onMove = (ev: PointerEvent) => {
          const r = el.getBoundingClientRect();
          mouse.x = ((ev.clientX - r.left) / r.width - 0.5) * 2;
          mouse.y = -((ev.clientY - r.top) / r.height - 0.5) * 2;
        };
        window.addEventListener("resize", onResize);

        let tween: gsap.core.Tween | null = null;
        const tick = () => {
          paint();
          render();
        };

        if (reduce) {
          stateProg.prog = LEVELS;
          paint();
          render();
        } else {
          el.addEventListener("pointermove", onMove);
          tween = gsap.fromTo(
            stateProg,
            { prog: 0 },
            { prog: LEVELS, duration: 5.2, ease: "none", repeat: -1, repeatDelay: 0.7 }
          );
          gsap.ticker.add(tick);
        }

        cleanup = () => {
          window.removeEventListener("resize", onResize);
          el.removeEventListener("pointermove", onMove);
          if (tween) tween.kill();
          gsap.ticker.remove(tick);
          cubeGeo.dispose();
          for (const n of nodes) n.mat.dispose();
          edgeGeo.dispose();
          edgeMat.dispose();
          pulseGeo.dispose();
          pulseMat.dispose();
          dustGeo.dispose();
          (dust.material as THREE.PointsMaterial).dispose();
          renderer.dispose();
          if (cv.parentNode) cv.parentNode.removeChild(cv);
        };
      } catch {
        // 3D hero is decorative only; ignore load failures
      }
    })();

    return () => {
      cancelled = true;
      if (cleanup) cleanup();
    };
  }, [ref]);
}

const verdictCopy: Record<string, { head: string; line: string }> = {
  FAIR: {
    head: "The draw holds",
    line: "Seeds track the published rankings. No concrete seeding anomaly was counted.",
  },
  CONTESTED: {
    head: "The draw is in question",
    line: "Anomalies were counted against the seeding record. It does not cleanly match the rankings.",
  },
  RIGGED: {
    head: "The draw was engineered",
    line: "Enough seeding anomalies were counted to indicate the bracket was arranged to favour an outcome.",
  },
  PENDING: { head: "Not yet ruled", line: "Audit the seeding, then evaluate fairness to obtain a ruling." },
};

function errMsg(e: unknown): string {
  const m = (e as { message?: string })?.message;
  return (m ? String(m) : "Something went wrong.").slice(0, 200);
}

export function App() {
  const { address, isConnected } = useAccount();
  const { data: walletClient } = useWalletClient();
  const addr = address as Hex | undefined;
  const heroRef = useRef<HTMLDivElement>(null);
  useBracketScene(heroRef);

  const [name, setName] = useState("");
  const [discipline, setDiscipline] = useState("Chess");
  const [size, setSize] = useState(16);
  const [draw, setDraw] = useState("");
  const [redraw, setRedraw] = useState("");
  const [trackId, setTrackId] = useState("0");

  const [card, setCard] = useState<BracketCard | null>(null);
  const [anomalies, setAnomalies] = useState<AnomalyItem[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [bands, setBands] = useState<FairnessBands | null>(null);

  const [rulingDist, setRulingDist] = useState<Record<string, number>>({});
  const [phaseDist, setPhaseDist] = useState<Record<string, number>>({});
  const [topTours, setTopTours] = useState<TopTournament[]>([]);
  const [anomalyKinds, setAnomalyKinds] = useState<AnomalyKindRow[]>([]);
  const [mine, setMine] = useState<SubmitterBracket[]>([]);

  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function refreshStats() {
    try {
      const [s, b] = await Promise.all([getStats(), getFairnessBands()]);
      setStats(s);
      setBands(b);
    } catch {
      /* keep last values */
    }
  }

  async function refreshRegistry() {
    try {
      const [rd, pd, tt, ak] = await Promise.all([
        getRulingDistribution(),
        getPhaseDistribution(),
        topTournaments(5),
        listAnomalyKinds(),
      ]);
      setRulingDist(rd || {});
      setPhaseDist(pd || {});
      setTopTours(
        (Array.isArray(tt) ? tt : []).map((t) => ({
          tournament: String(t.tournament ?? ""),
          tournamentHash: String(t.tournament_hash ?? ""),
          brackets: toNum(t.brackets),
          rigged: toNum(t.rigged),
          score: toNum(t.score),
        }))
      );
      setAnomalyKinds(
        (Array.isArray(ak) ? ak : []).map((k) => ({
          kindId: toNum(k.kind_id),
          name: String(k.name ?? ""),
          severity: toNum(k.severity),
        }))
      );
    } catch {
      /* keep last values */
    }
  }

  async function loadMine(forAddr?: Hex) {
    if (!forAddr) { setMine([]); return; }
    try {
      const list = await listBracketsBySubmitter(forAddr);
      setMine(
        (Array.isArray(list) ? list : []).map((b) => ({
          bracketId: toNum(b.bracket_id),
          tournament: String(b.tournament ?? ""),
          status: String(b.status ?? ""),
          ruling: String(b.ruling ?? ""),
        }))
      );
    } catch {
      setMine([]);
    }
  }

  useEffect(() => { refreshStats(); }, []);
  useEffect(() => { refreshRegistry(); }, []);
  useEffect(() => { loadMine(addr); }, [addr]);

  async function loadBracket(id: number) {
    const [c, a] = await Promise.all([getBracketCard(id), getAnomalies(id)]);
    setCard(c);
    setAnomalies(a);
    return c;
  }

  async function onLoad() {
    const id = Number(trackId.trim());
    if (!Number.isInteger(id) || id < 0) { setError("Enter a valid bracket id (0 or higher)."); return; }
    setBusy("load"); setError(""); setNotice("");
    try {
      await loadBracket(id);
    } catch (e) {
      setCard(null); setAnomalies([]);
      setError(errMsg(e) || "Could not load that bracket.");
    } finally {
      setBusy(null);
    }
  }

  const composedDraw = () => {
    const header = `Format: ${size}-seed single-elimination ${discipline}.\n`;
    return header + draw.trim();
  };

  async function onSubmit() {
    if (!addr || !walletClient) return;
    setBusy("submit"); setError(""); setNotice("");
    try {
      await submitBracket(walletClient, name.trim(), composedDraw());
      const s = await getStats();
      setStats(s);
      const newId = Math.max(0, s.nextBracketId - 1);
      setTrackId(String(newId));
      await loadBracket(newId);
      await refreshStats();
      await refreshRegistry();
      await loadMine(addr);
      setNotice(`Draw filed on-chain as bracket #${newId}. Now run Audit, then Evaluate.`);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(null);
    }
  }

  async function runStep(key: Busy, fn: (wallet: typeof walletClient, id: number) => Promise<string>) {
    if (!walletClient || !card) return;
    const id = card.bracketId;
    setBusy(key); setError(""); setNotice("");
    try {
      await fn(walletClient, id);
      await loadBracket(id);
      await refreshStats();
      await refreshRegistry();
      await loadMine(addr);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(null);
    }
  }

  async function onResubmit() {
    if (!walletClient || !card) return;
    setBusy("resubmit"); setError(""); setNotice("");
    try {
      await resubmitDraw(walletClient, card.bracketId, redraw.trim());
      setRedraw("");
      await loadBracket(card.bracketId);
      setNotice("New draw stored. Run Audit again.");
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(null);
    }
  }

  const canSubmit = !!isConnected && !!walletClient && name.trim().length >= 2 && draw.trim().length >= 40 && !busy;
  const v = card?.ruling || "";
  const status = card?.status || "";
  const isSubmitter = !!addr && !!card && card.submitter.toLowerCase().includes(addr.slice(2, 8).toLowerCase());
  const rulingMax = Math.max(1, ...RULING_ORDER.map((k) => toNum(rulingDist[k])));

  return (
    <div className="arena">
      <header className="crown">
        <span className="brand">
          <span className="brand-mark" aria-hidden="true" />
          Seedline
        </span>
        <WalletControl />
      </header>

      <section className="stage" ref={heroRef}>
        <div className="stage-copy">
          <span className="kicker">Bracket integrity court</span>
          <h1>Was this bracket seeded fairly, or arranged to clear a path?</h1>
          <p>
            File a draw on-chain &mdash; the seeding algorithm, the assigned seeds and the ranking
            history. A panel of GenLayer validators independently counts the concrete seeding
            anomalies; that count rules the draw FAIR, CONTESTED or RIGGED, and contested draws go
            back for a versioned re-draw.
          </p>
        </div>
      </section>

      {/* stats strip */}
      <section className="stats">
        <div className="stat"><span className="stat-v">{stats ? stats.nextBracketId : "-"}</span><span className="stat-k">Brackets filed</span></div>
        <div className="stat"><span className="stat-v">{stats ? stats.evaluatedCount : "-"}</span><span className="stat-k">Evaluated</span></div>
        <div className="stat"><span className="stat-v">{stats ? stats.fairCount : "-"}</span><span className="stat-k">Ruled fair</span></div>
        <div className="stat"><span className="stat-v">{stats ? stats.redrawCount : "-"}</span><span className="stat-k">Re-draws</span></div>
        <div className="stat">
          <span className="stat-v">{bands ? `${bands.contestedFloor}/${bands.riggedFloor}` : "-"}</span>
          <span className="stat-k">Contested / rigged floor</span>
        </div>
      </section>

      <main className="grounds">
        <section className="draw">
          <div className="draw-head">
            <span>File a draw</span>
            <span className="draw-id">DRAW . {discipline.slice(0, 3).toUpperCase()}/{size}</span>
          </div>

          <label className="field">
            <span className="field-k">Tournament name</span>
            <span className="field-hint">A short title for the tournament whose draw is under question.</span>
            <input
              className="namein"
              value={name}
              maxLength={40}
              onChange={(e) => setName(e.target.value)}
              placeholder="City Autumn Open"
              aria-label="Tournament name"
            />
          </label>

          <div className="picker">
            <span className="picker-k">Discipline</span>
            <div className="chips">
              {DISCIPLINES.map((d) => (
                <button key={d} type="button" className={"chip" + (discipline === d ? " chip-on" : "")} onClick={() => setDiscipline(d)}>{d}</button>
              ))}
            </div>
          </div>

          <div className="picker">
            <span className="picker-k">Bracket size</span>
            <div className="chips">
              {SIZES.map((s) => (
                <button key={s} type="button" className={"chip chip-sq" + (size === s ? " chip-on" : "")} onClick={() => setSize(s)}>{s}</button>
              ))}
            </div>
          </div>

          <label className="field">
            <span className="field-k">The draw (read on-chain)</span>
            <span className="field-hint">
              Paste the seeding algorithm, the assigned seeds and the ranking/results history. Validators read
              THIS text and count concrete anomalies &mdash; {draw.trim().length} chars (min 40).
            </span>
            <textarea
              className="drawin"
              rows={6}
              value={draw}
              onChange={(e) => setDraw(e.target.value)}
              placeholder={"Seeding: rank-based. Seeds 1-8 by world ranking points. Paths 1v8,4v5,3v6,2v7. Results history consistent. No manual overrides."}
              aria-label="Draw data"
            />
          </label>

          <button className="runbtn" disabled={!canSubmit} onClick={onSubmit}>
            {busy === "submit" ? "Filing the draw on-chain..." : "File the draw"}
          </button>
          {!isConnected && <span className="needwallet">Connect a wallet to file a draw.</span>}

          <div className="track">
            <span className="picker-k">Inspect a filed bracket</span>
            <div className="track-row">
              <input className="namein" value={trackId} onChange={(e) => setTrackId(e.target.value)} placeholder="0" inputMode="numeric" aria-label="Bracket id" />
              <button className="chip" type="button" onClick={onLoad} disabled={!!busy}>{busy === "load" ? "..." : "Load"}</button>
            </div>
          </div>

          {error && <p className="err">{error}</p>}
          {notice && <p className="assembled"><strong>{notice}</strong></p>}
        </section>

        <aside className="ruling">
          {card ? (
            <div className={"verdict v-" + (v || "PENDING")}>
              <span className="verdict-tag">Bracket #{card.bracketId} &middot; {status}</span>
              <div className="verdict-word">{v || "PENDING"}</div>
              <h3>{verdictCopy[v]?.head || "Ruled"}</h3>
              <p className="verdict-line">{verdictCopy[v]?.line || ""}</p>

              <div className="kv">
                <span><b>{card.tournament}</b></span>
                <span>seeding anomalies: <b>{card.seedingAnomalies}</b> &middot; severity {card.severityTotal} &middot; re-draw round {card.redrawRound}</span>
                <span>submitter {card.submitter}</span>
              </div>

              {card.rationale && <p className="verdict-sum">{card.rationale}</p>}

              {anomalies.length > 0 && (
                <ul className="anoms">
                  {anomalies.map((a) => (
                    <li key={a.anomalyId} className="anom">
                      <span className="anom-kind">{a.kind}</span>
                      <span className="anom-sev">sev {a.severity}</span>
                      <span className="anom-note">{a.note}</span>
                    </li>
                  ))}
                </ul>
              )}

              <div className="acts">
                {!isConnected && <span className="needwallet">Connect a wallet to act on this bracket.</span>}
                {isConnected && (status === "SUBMITTED" || status === "REDRAW") && (
                  <button className="act" disabled={!!busy} onClick={() => runStep("audit", auditSeed)}>
                    {busy === "audit" ? "Validators counting anomalies..." : "Audit the seeding (AI panel)"}
                  </button>
                )}
                {isConnected && status === "AUDITED" && (
                  <button className="act" disabled={!!busy} onClick={() => runStep("evaluate", evaluateFairness)}>
                    {busy === "evaluate" ? "Ruling..." : "Evaluate fairness"}
                  </button>
                )}
                {isConnected && status === "EVALUATED" && (
                  <button className="act" disabled={!!busy} onClick={() => runStep("ratify", ratify)}>
                    {busy === "ratify" ? "Settling..." : v === "FAIR" ? "Ratify the draw" : "Order a re-draw"}
                  </button>
                )}
                {isConnected && status === "REDRAW" && (
                  <div className="redraw">
                    <textarea className="drawin" rows={4} value={redraw} onChange={(e) => setRedraw(e.target.value)} placeholder="New draw text for the re-draw (min 40 chars)" aria-label="Re-draw data" />
                    <button className="act" disabled={!!busy || redraw.trim().length < 40} onClick={onResubmit}>
                      {busy === "resubmit" ? "Storing..." : "Resubmit the draw"}
                    </button>
                  </div>
                )}
                {isConnected && isSubmitter && status !== "RATIFIED" && status !== "RETIRED" && (
                  <button className="act act-ghost" disabled={!!busy} onClick={() => runStep("retire", (a, id) => retireBracket(a, id, "retired from UI"))}>
                    {busy === "retire" ? "Retiring..." : "Retire bracket"}
                  </button>
                )}
              </div>
              <span className="verdict-foot">Settled on the draw ledger</span>
            </div>
          ) : (
            <div className="slate slate-empty">
              <span className="slate-tree" aria-hidden="true" />
              <p>File a draw or load one by id. The seeding ruling, anomalies and re-draw history print here.</p>
            </div>
          )}
        </aside>
      </main>

      {/* fairness registry: real on-chain read views rendered as themed UI */}
      <section className="registry">
        <div className="draw-head"><span>Fairness registry</span><span className="draw-id">ON-CHAIN VIEWS</span></div>

        <div className="registry-grid">
          <div className="reg-card">
            <span className="reg-k">Ruling distribution</span>
            <ul className="rulebars">
              {RULING_ORDER.map((key) => {
                const count = toNum(rulingDist[key]);
                const pct = Math.round((count / rulingMax) * 100);
                return (
                  <li key={key} className={"rulebar rb-" + key}>
                    <span className="rulebar-k">{key}</span>
                    <span className="rulebar-track" aria-hidden="true">
                      <span className="rulebar-fill" style={{ width: pct + "%" }} />
                    </span>
                    <span className="rulebar-v">{count}</span>
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="reg-card">
            <span className="reg-k">Phase distribution</span>
            <div className="phase-tiles">
              {PHASE_ORDER.map((key) => (
                <div key={key} className="phase-tile">
                  <span className="phase-v">{toNum(phaseDist[key])}</span>
                  <span className="phase-k">{key}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="registry-grid">
          <div className="reg-card">
            <span className="reg-k">Top tournaments</span>
            {topTours.length > 0 ? (
              <ol className="toplist">
                {topTours.map((t, i) => (
                  <li key={t.tournamentHash || t.tournament || i} className="toprow">
                    <span className="toprank">{i + 1}</span>
                    <span className="topname" title={t.tournament}>{t.tournament || "(untitled)"}</span>
                    <span className="topmeta">
                      <span className="topscore">score {t.score}</span>
                      <span className={"toprig" + (t.rigged > 0 ? " toprig-on" : "")}>{t.rigged} rigged</span>
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="reg-empty">No tournaments on the ledger yet.</p>
            )}
          </div>

          <div className="reg-card">
            <span className="reg-k">Anomaly kinds</span>
            <ul className="kindlegend">
              {anomalyKinds.map((k) => (
                <li key={k.kindId} className={"kindrow ks-" + sevClass(k.severity)}>
                  <span className="kinddot" aria-hidden="true" />
                  <span className="kindname">{k.name}</span>
                  <span className="kindsev">sev {k.severity}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {isConnected && mine.length > 0 && (
          <div className="reg-card reg-mine">
            <span className="reg-k">My brackets</span>
            <ul className="minelist">
              {mine.map((b) => (
                <li key={b.bracketId} className="minerow">
                  <button
                    type="button"
                    className="mine-id"
                    disabled={!!busy}
                    onClick={() => { setTrackId(String(b.bracketId)); loadBracket(b.bracketId).catch(() => setError("Could not load that bracket.")); }}
                  >
                    #{b.bracketId}
                  </button>
                  <span className="mine-name" title={b.tournament}>{b.tournament || "(untitled)"}</span>
                  <span className={"mine-rule rb-" + (b.ruling || "PENDING")}>{b.ruling || "PENDING"}</span>
                  <span className="mine-status">{b.status}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <footer className="baseline">
        <span>Seedline rules tournament seeding on GenLayer StudioNet (chain {GENLAYER_CHAIN_ID}).</span>
        <a className="mono" href={GENLAYER_EXPLORER_URL + "/address/" + CONTRACT_ADDRESS} target="_blank" rel="noreferrer">
          draw ledger {CONTRACT_ADDRESS.slice(0, 6)}...{CONTRACT_ADDRESS.slice(-4)}
        </a>
      </footer>
    </div>
  );
}
