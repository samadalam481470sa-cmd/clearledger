# Besu development network

The supplied configuration targets four local QBFT validators using Besu 26.10.1. Its generator/configuration tests pass, and a real-network acceptance script plus Docker CI workflow are provided. Docker execution and validator failover remain unverified until that workflow completes successfully; Docker is unavailable on the initial Windows host.

1. Install Node.js 24+, npm, Docker, and Compose.
2. Run `npm ci`, then `npm run network:generate`.
3. Run `docker compose -f network/compose.yaml up -d`.
4. Run `npm run network:verify` to execute the bounded acceptance checks described below.
5. Optionally run `npm run network:deploy` to save separate test-account deployment details.
6. Configure RPC service variables from that generated deployment and run `npm start`.

The generator creates random validator identities, genesis RLP data, static peers, valid newline-terminated TOML node-permission lists, and a funded development deployment account. Each node receives an identical genesis copy inside its own read-only configuration mount, avoiding nested mounts. It refuses to replace an existing `network/generated/` directory. Generated account credentials and validator keys are ignored by Git.

Chain ID is 20261024, with a two-second block period, four-second request timeout, and zero gas price. The contracts target Paris-compatible bytecode. File mode 0600 is requested for keys where supported; Windows directory ACLs remain the operating-system boundary.

All RPC endpoints are loopback-only: validator 1 at port 8545, validator 2 at 8546, validator 3 at 8547, and validator 4 at 8548. The acceptance script reads all four directly. Nodes use fixed addresses in the isolated `172.28.77.0/24` bridge. If that subnet conflicts locally, update addresses and peers consistently. Development containers run as root to avoid bind-mount ownership friction; a production setup needs a reviewed least-privilege design.

The verified Docker Hub release image is pinned as `hyperledger/besu:26.10.1@sha256:47aa21463213abcddc5972bc79443e6806c1c7c68e8f36ed33222882fbad8752`. JVM options `-Xms128m -Xmx512m` bound each development container's heap for CI; they are not a production capacity recommendation.

Node permissioning does not make transactions private. Token account eligibility is a separate application policy. All four containers share one host and are not independent failure domains.

## Executable acceptance checks

`npm run network:verify` connects to all four loopback RPC endpoints and checks:

- All four report chain ID 20261024, the generated QBFT validator membership, and a common canonical block hash with close head heights.
- Fresh test contracts execute a signed 125 dUSD payment, yield one transfer journal, and reconcile without exceptions.
- Stopping only `validator4` in the exact `clearledger-dev` Compose project leaves the other three progressing by at least two blocks and agreeing on the chain.
- Restarting validator 4 restores four-node agreement and catches it up to the observed progress.

The script has an eight-minute budget, bounded RPC/Compose operations, a best-effort restart of validator 4 on failure, and avoids logging generated keys. It does not stop other Docker projects or validators. Its journal is temporary memory state; `network:deploy` separately writes ignored reusable development-account credentials.

`.github/workflows/network.yml` runs this acceptance path on relevant pushes or manual dispatch, with a 15-minute job budget. Its cleanup removes only the workflow's ephemeral Compose network/volumes. Providing the workflow is not evidence that it has passed; the runtime result is pending.

Two generator/configuration tests pass for cryptographic identity/membership consistency, enodes, copied genesis, minimal round-zero RLP, permission TOML, and refusal to replace existing keys. They do not execute consensus.

Still beyond the script: loss of two validators, hostile/unapproved-peer attempts, independent-host failures, prolonged soak/load behavior, external port probing, and production fault tolerance.

References: [Besu QBFT tutorial](https://docs.besu-eth.org/private-networks/tutorials/qbft), [permissioning](https://docs.besu-eth.org/private-networks/concepts/permissioning).
