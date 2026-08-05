# Tournament-Seed response

## Wallet signer write path

The frontend now uses the connected RainbowKit/wagmi wallet as the actual transaction signer.

Repository-visible path:

- `frontend/src/App.tsx`
  - imports `useWalletClient` from `wagmi`;
  - reads `const { data: walletClient } = useWalletClient()`;
  - passes `walletClient` into every lifecycle write:
    - `submitBracket`
    - `auditSeed`
    - `evaluateFairness`
    - `ratify`
    - `resubmitDraw`
    - `retireBracket`

- `frontend/src/contractService.ts`
  - requires `wallet.account.address`;
  - requires `wallet.transport.request`;
  - creates the GenLayer write client with:
    - `account: walletClient.account.address`
    - `provider.request` backed by the connected wallet transport
  - all write functions call this signer-backed client before `writeContract`.

This means the connected address is not merely passed as a string. The browser wallet transport is the authorization path used by `genlayer-js` to complete contract writes.

## Verification

- GenVM lint: PASS
- Direct tests: 3/3 PASS
- Frontend production build: PASS
- StudioNet smoke script: `frontend/scripts/studionet-smoke.mjs`
