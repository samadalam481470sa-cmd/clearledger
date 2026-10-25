# Besu development network

The supplied configuration targets four local QBFT validators using Besu 26.10.1. Docker execution and validator failover have not yet been verified on the initial host.

1. Install Node.js 24+, npm, Docker, and Compose.
2. Run `npm ci`, then `npm run network:generate`.
3. Run `docker compose -f network/compose.yaml up -d`.
4. Inspect node logs and query `eth_blockNumber` at http://127.0.0.1:8545.
5. Run `npm run network:deploy` after the chain is producing blocks.
6. Configure RPC service variables from the generated deployment and run `npm start`.

The generator creates random validator identities, genesis RLP data, static peers, node permission lists, and a funded development deployment account. It refuses to replace an existing `network/generated/` directory. Generated account credentials and validator keys are ignored by Git.

Chain ID is 20261024, with a two-second block period, four-second request timeout, and zero gas price. The contracts target Paris-compatible bytecode. File mode 0600 is requested for keys where supported; Windows directory ACLs remain the operating-system boundary.

Only validator 1's JSON-RPC endpoint is published, on loopback. Nodes use fixed addresses in the isolated `172.28.77.0/24` bridge. If that subnet conflicts locally, update addresses and peers consistently. Development containers run as root to avoid bind-mount ownership friction; a production setup needs a reviewed least-privilege design.

Node permissioning does not make transactions private. Token account eligibility is a separate application policy. All four containers share one host and are not independent failure domains.

## Acceptance checks still required

- Four nodes agree on chain ID and canonical block hash.
- A signed payment settles and reconciles through the API.
- One stopped validator does not prevent the remaining quorum from progressing.
- Loss of sufficient validators stalls finalization rather than producing conflicting histories.
- Restart preserves state and restores membership.
- Unapproved peers cannot join the configured nodes.
- RPC remains inaccessible outside loopback.

References: [Besu QBFT tutorial](https://docs.besu-eth.org/private-networks/tutorials/qbft), [permissioning](https://docs.besu-eth.org/private-networks/concepts/permissioning).
