import { readFile } from "node:fs/promises";
import { createAccount, createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { ExecutionResult, TransactionStatus } from "genlayer-js/types";

let contractAddress = process.env.TOURNAMENT_SEED_CONTRACT_ADDRESS || "";
const pk = process.env.TOURNAMENT_SEED_DEPLOYER_PK;

if (!pk) {
  throw new Error("Set TOURNAMENT_SEED_DEPLOYER_PK before running this smoke test.");
}

const account = createAccount(pk.startsWith("0x") ? pk : `0x${pk}`);
const client = createClient({ chain: studionet, account });
const transactions = [];

const cleanDraw = [
  "Format: 8-seed single-elimination chess bracket.",
  "Seeding is rank-based and exactly follows published ranking points.",
  "Seeds are 1v8, 4v5, 3v6, 2v7.",
  "There are no withdrawals, no manual overrides, and no repeated suspicious pairings.",
].join(" ");

const riggedDraw = [
  "Format: 8-seed single-elimination tennis bracket.",
  "Published rankings are Alpha #1, Beta #2, Gamma #3, Delta #4, Epsilon #5, Zeta #6, Eta #7, Theta #8.",
  "The organiser secretly changes the official algorithm after publication.",
  "Alpha #1 is protected: Beta #2, Gamma #3, and Delta #4 are all placed on the opposite half.",
  "Two teammates who normally should be separated are clustered in one quarter.",
  "This contradicts the stated rank-based 1v8, 4v5, 3v6, 2v7 seeding rule.",
].join(" ");

const revisedDraw = [
  "Revised 8-seed bracket regenerated strictly by published ranking.",
  "The path is 1v8, 4v5, 3v6, 2v7.",
  "Manual overrides are removed and same-club entrants are distributed across the bracket.",
].join(" ");

function assertOk(condition, message) {
  if (!condition) throw new Error(message);
}

function receiptOk(receipt) {
  const leaderResult = receipt.consensus_data?.leader_receipt?.[0]?.execution_result;
  return receipt.txExecutionResultName === ExecutionResult.FINISHED_WITH_RETURN
    || leaderResult === "SUCCESS"
    || receipt.execution_result === "SUCCESS";
}

async function waitFor(hash, label, fullTransaction = false) {
  const receipt = await client.waitForTransactionReceipt({
    hash,
    status: TransactionStatus.ACCEPTED,
    interval: 5000,
    retries: 120,
    fullTransaction,
  });
  assertOk(receiptOk(receipt), `${label} failed execution: ${hash}`);
  return receipt;
}

async function deployIfNeeded() {
  if (contractAddress) return "";
  const code = await readFile(new URL("../../backend/tournament-seed.py", import.meta.url), "utf8");
  const hash = await client.deployContract({ code });
  const receipt = await waitFor(hash, "deploy", true);
  contractAddress = receipt.recipient || receipt.txDataDecoded?.contractAddress || "";
  assertOk(contractAddress, `deploy succeeded but contract address was not found: ${hash}`);
  transactions.push({ functionName: "deploy", hash });
  console.log(`deploy: ${hash}`);
  console.log(`contract=${contractAddress}`);
  return hash;
}

async function read(functionName, args = []) {
  return await client.readContract({ address: contractAddress, functionName, args });
}

async function write(functionName, args = []) {
  const hash = await client.writeContract({
    address: contractAddress,
    functionName,
    args,
    value: 0n,
  });
  await waitFor(hash, functionName);
  transactions.push({ functionName, hash });
  console.log(`${functionName}: ${hash}`);
  return hash;
}

async function main() {
  console.log(`deployer=${account.address}`);
  await deployIfNeeded();

  const before = await read("tournament_stats");
  console.log(`before.next_bracket_id=${before.next_bracket_id}`);

  await write("submit_bracket", ["Onchain Fair Smoke", cleanDraw]);
  const afterSubmit = await read("tournament_stats");
  const fairId = Number(afterSubmit.next_bracket_id) - 1;
  assertOk(fairId >= 0, "fair bracket id not created");

  await write("audit_seed", [fairId]);
  await write("evaluate_fairness", [fairId]);
  const fairCard = await read("get_bracket_card", [fairId]);
  console.log(`fairCard.status=${fairCard.status} ruling=${fairCard.ruling} anomalies=${fairCard.seeding_anomalies}`);
  assertOk(fairCard.status === "EVALUATED", "fair bracket did not reach EVALUATED");
  await write("ratify", [fairId]);

  await write("submit_bracket", ["Onchain Redraw Smoke", riggedDraw]);
  const afterRiggedSubmit = await read("tournament_stats");
  const riggedId = Number(afterRiggedSubmit.next_bracket_id) - 1;

  await write("audit_seed", [riggedId]);
  await write("evaluate_fairness", [riggedId]);
  const riggedCard = await read("get_bracket_card", [riggedId]);
  console.log(`riggedCard.status=${riggedCard.status} ruling=${riggedCard.ruling} anomalies=${riggedCard.seeding_anomalies}`);
  assertOk(riggedCard.status === "EVALUATED", "rigged bracket did not reach EVALUATED");

  await write("ratify", [riggedId]);
  const afterRiggedRatify = await read("get_bracket_card", [riggedId]);
  if (afterRiggedRatify.status === "REDRAW") {
    await write("resubmit_draw", [riggedId, revisedDraw]);
    await write("retire_bracket", [riggedId, "on-chain smoke finished after redraw path"]);
  } else {
    await write("submit_bracket", ["Onchain Retire Smoke", cleanDraw]);
    const afterRetireSubmit = await read("tournament_stats");
    await write("retire_bracket", [Number(afterRetireSubmit.next_bracket_id) - 1, "on-chain smoke retire path"]);
  }

  const views = {
    get_bracket: await read("get_bracket", [fairId]),
    get_bracket_card: await read("get_bracket_card", [fairId]),
    get_anomalies: await read("get_anomalies", [fairId]),
    get_revisions: await read("get_revisions", [riggedId]),
    get_tournament_roll: await read("get_tournament_roll", ["Onchain Fair Smoke"]),
    list_brackets_by_tournament: await read("list_brackets_by_tournament", ["Onchain Fair Smoke", 0, 10]),
    list_brackets_by_submitter: await read("list_brackets_by_submitter", [account.address]),
    get_audit_log: await read("get_audit_log", [0, 20]),
    get_ruling_distribution: await read("get_ruling_distribution"),
    get_phase_distribution: await read("get_phase_distribution"),
    top_tournaments: await read("top_tournaments", [5]),
    list_anomaly_kinds: await read("list_anomaly_kinds"),
    tournament_stats: await read("tournament_stats"),
    get_fairness_bands: await read("get_fairness_bands"),
  };

  assertOk(views.list_brackets_by_tournament.length > 0, "tournament index did not include bracket");
  assertOk(views.list_brackets_by_submitter.length > 0, "submitter index did not include bracket");
  assertOk(views.get_audit_log.length > 0, "audit log is empty");
  assertOk(views.list_anomaly_kinds.length === 5, "anomaly kind catalogue incomplete");

  console.log(JSON.stringify({
    contractAddress,
    deployer: account.address,
    fairId,
    riggedId,
    transactions,
    verifiedViews: Object.keys(views),
    finalStats: views.tournament_stats,
  }, (_, value) => typeof value === "bigint" ? value.toString() : value));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
