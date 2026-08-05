import { createClient, createAccount } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";
import type { WalletClient } from "viem";
import { CONTRACT_ADDRESS, GENLAYER_NETWORK } from "./chain";

type Hex = `0x${string}`;
type WalletProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};
export type ConnectedWallet = WalletClient & {
  account: NonNullable<WalletClient["account"]>;
  transport: WalletClient["transport"] & WalletProvider;
};
const ADDR = CONTRACT_ADDRESS as Hex;
const TIMEOUT_MS = 300_000;

// Phase / Ruling names exactly as the contract emits them.
export const PHASE = {
  SUBMITTED: "SUBMITTED",
  AUDITED: "AUDITED",
  EVALUATED: "EVALUATED",
  RATIFIED: "RATIFIED",
  REDRAW: "REDRAW",
  RETIRED: "RETIRED",
} as const;

export const RULING = {
  PENDING: "PENDING",
  FAIR: "FAIR",
  CONTESTED: "CONTESTED",
  RIGGED: "RIGGED",
} as const;

export interface BracketCard {
  bracketId: number;
  submitter: string;
  tournament: string;
  tournamentHash: string;
  drawHash: string;
  status: string;
  ruling: string;
  seedingAnomalies: number;
  severityTotal: number;
  anomalyCount: number;
  redrawRound: number;
  rationale: string;
  submittedSeq: number;
  auditedSeq: number;
  evaluatedSeq: number;
  settledSeq: number;
}

export interface AnomalyItem {
  anomalyId: number;
  kind: string;
  severity: number;
  note: string;
  redrawRound: number;
  detectedSeq: number;
}

export interface Stats {
  nextBracketId: number;
  nextAnomalyId: number;
  nextSeq: number;
  evaluatedCount: number;
  fairCount: number;
  redrawCount: number;
}

export interface FairnessBands {
  contestedFloor: number;
  riggedFloor: number;
  anomalyTolerance: number;
  anomalyMax: number;
  redrawCap: number;
}

// --- clients --------------------------------------------------------------

let _read: ReturnType<typeof createClient> | null = null;
function readClient() {
  if (!_read) _read = createClient({ chain: studionet, account: createAccount() });
  return _read;
}

function requireConnectedWallet(wallet: WalletClient | undefined): ConnectedWallet {
  if (!wallet?.account?.address) {
    throw new Error("Connect a wallet before sending a transaction.");
  }
  if (typeof wallet.transport?.request !== "function") {
    throw new Error("Connected wallet does not expose an EIP-1193 request signer.");
  }
  return wallet as ConnectedWallet;
}

function writeClient(wallet: WalletClient | undefined) {
  const signer = requireConnectedWallet(wallet);
  return createClient({
    chain: studionet,
    account: signer.account.address as Hex,
    provider: {
      request: (args: { method: string; params?: unknown[] }) => signer.transport.request(args),
    },
  });
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

async function readView(functionName: string, args: any[] = []): Promise<any> {
  return await readClient().readContract({ address: ADDR, functionName, args });
}

async function send(wallet: WalletClient | undefined, functionName: string, args: any[]): Promise<string> {
  const client = writeClient(wallet);
  await client.connect(GENLAYER_NETWORK);
  const hash = await client.writeContract({ address: ADDR, functionName, args, value: 0n });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Transaction timed out")), TIMEOUT_MS);
  });
  try {
    await Promise.race([
      client.waitForTransactionReceipt({
        hash,
        status: TransactionStatus.ACCEPTED,
        interval: 5000,
        retries: 60,
      }),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  return String(hash);
}

// --- mappers --------------------------------------------------------------

function toCard(r: Record<string, unknown>): BracketCard {
  return {
    bracketId: num(r.bracket_id),
    submitter: String(r.submitter ?? ""),
    tournament: String(r.tournament ?? ""),
    tournamentHash: String(r.tournament_hash ?? ""),
    drawHash: String(r.draw_hash ?? ""),
    status: String(r.status ?? ""),
    ruling: String(r.ruling ?? ""),
    seedingAnomalies: num(r.seeding_anomalies),
    severityTotal: num(r.severity_total),
    anomalyCount: num(r.anomaly_count),
    redrawRound: num(r.redraw_round),
    rationale: String(r.rationale ?? ""),
    submittedSeq: num(r.submitted_seq),
    auditedSeq: num(r.audited_seq),
    evaluatedSeq: num(r.evaluated_seq),
    settledSeq: num(r.settled_seq),
  };
}

// --- reads (all 14 views) -------------------------------------------------

export async function getStats(): Promise<Stats> {
  const r = (await readView("tournament_stats")) as Record<string, unknown>;
  return {
    nextBracketId: num(r.next_bracket_id),
    nextAnomalyId: num(r.next_anomaly_id),
    nextSeq: num(r.next_seq),
    evaluatedCount: num(r.evaluated_count),
    fairCount: num(r.fair_count),
    redrawCount: num(r.redraw_count),
  };
}

export async function getFairnessBands(): Promise<FairnessBands> {
  const r = (await readView("get_fairness_bands")) as Record<string, unknown>;
  return {
    contestedFloor: num(r.contested_floor),
    riggedFloor: num(r.rigged_floor),
    anomalyTolerance: num(r.anomaly_tolerance),
    anomalyMax: num(r.anomaly_max),
    redrawCap: num(r.redraw_cap),
  };
}

export async function getBracketCard(id: number): Promise<BracketCard> {
  return toCard((await readView("get_bracket_card", [id])) as Record<string, unknown>);
}

export async function getBracket(id: number): Promise<any> {
  return await readView("get_bracket", [id]);
}

export async function getAnomalies(id: number): Promise<AnomalyItem[]> {
  const list = (await readView("get_anomalies", [id])) as any[];
  return (Array.isArray(list) ? list : []).map((a) => ({
    anomalyId: num(a.anomaly_id),
    kind: String(a.kind ?? ""),
    severity: num(a.severity),
    note: String(a.note ?? ""),
    redrawRound: num(a.redraw_round),
    detectedSeq: num(a.detected_seq),
  }));
}

export async function getRevisions(id: number): Promise<any[]> {
  const list = (await readView("get_revisions", [id])) as any[];
  return Array.isArray(list) ? list : [];
}

export async function getTournamentRoll(tournament: string): Promise<any> {
  return await readView("get_tournament_roll", [tournament]);
}

export async function listBracketsByTournament(tournament: string, offset = 0, limit = 50): Promise<any[]> {
  const list = (await readView("list_brackets_by_tournament", [tournament, offset, limit])) as any[];
  return Array.isArray(list) ? list : [];
}

export async function listBracketsBySubmitter(submitter: string): Promise<any[]> {
  const list = (await readView("list_brackets_by_submitter", [submitter])) as any[];
  return Array.isArray(list) ? list : [];
}

export async function getAuditLog(offset = 0, limit = 50): Promise<any[]> {
  const list = (await readView("get_audit_log", [offset, limit])) as any[];
  return Array.isArray(list) ? list : [];
}

export async function getRulingDistribution(): Promise<Record<string, number>> {
  return ((await readView("get_ruling_distribution")) as Record<string, number>) ?? {};
}

export async function getPhaseDistribution(): Promise<Record<string, number>> {
  return ((await readView("get_phase_distribution")) as Record<string, number>) ?? {};
}

export async function topTournaments(limit = 5): Promise<any[]> {
  const list = (await readView("top_tournaments", [limit])) as any[];
  return Array.isArray(list) ? list : [];
}

export async function listAnomalyKinds(): Promise<any[]> {
  const list = (await readView("list_anomaly_kinds")) as any[];
  return Array.isArray(list) ? list : [];
}

// --- writes (all 6 lifecycle methods) -------------------------------------

export function submitBracket(wallet: WalletClient | undefined, tournament: string, drawData: string): Promise<string> {
  return send(wallet, "submit_bracket", [tournament, drawData]);
}

export function auditSeed(wallet: WalletClient | undefined, id: number): Promise<string> {
  return send(wallet, "audit_seed", [id]);
}

export function evaluateFairness(wallet: WalletClient | undefined, id: number): Promise<string> {
  return send(wallet, "evaluate_fairness", [id]);
}

export function ratify(wallet: WalletClient | undefined, id: number): Promise<string> {
  return send(wallet, "ratify", [id]);
}

export function resubmitDraw(wallet: WalletClient | undefined, id: number, drawData: string): Promise<string> {
  return send(wallet, "resubmit_draw", [id, drawData]);
}

export function retireBracket(wallet: WalletClient | undefined, id: number, reason: string): Promise<string> {
  return send(wallet, "retire_bracket", [id, reason]);
}
