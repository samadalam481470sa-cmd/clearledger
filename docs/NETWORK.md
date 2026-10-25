# Besu development network

The supplied configuration has four Besu 26.10.1 QBFT validators plus a separate RPC gateway. It passed real Docker acceptance on a single GitHub Actions Ubuntu host: agreement, signed settlement and reconciliation, continued progress with one validator stopped, and restart/catch-up. Docker remains unavailable on the initial Windows host, where this scenario has not been run.

1. Install Node.js 24+, npm, Docker, and Compose.
2. Run `npm ci`, then `npm run network:generate`.
3. Run `docker compose -f network/compose.yaml up -d`.
4. Run `npm run network:verify` to execute the bounded acceptance checks described below.
5. Optionally run `npm run network:deploy` to save separate test-account deployment details.
6. Configure RPC service variables from that generated deployment and run `npm start`.

Before generation and Docker startup on Linux, match the non-root container identity to the user creating the private keys:

```sh
export BESU_CONTAINER_UID=$(id -u)
export BESU_CONTAINER_GID=$(id -g)
```

Compose defaults to UID/GID 1000:1000 when these are unset. On Windows Docker Desktop, keep that default unless your installation requires another identity; Windows directory ACLs govern host access. Do not make validator keys world-readable to work around a mismatch.

The generator creates random validator identities, genesis RLP data, static peers, valid newline-terminated TOML node-permission lists, and a funded development deployment account. Each node receives an identical genesis copy inside its own read-only configuration mount, plus a separately mounted host-owned writable `generated/validatorN/data/` directory. It refuses to replace an existing `network/generated/` directory. Generated account credentials and validator keys are ignored by Git.

Chain ID is 20261024, with a two-second block period, four-second request timeout, and zero gas price. The contracts target Paris-compatible bytecode. File mode 0600 is requested for keys where supported; Windows directory ACLs remain the operating-system boundary.

Validators have no published host ports and remain exclusively on the internal `settlement` network. A separate `rpc` gateway joins `settlement` and the ordinary `rpc-access` bridge and publishes only host-loopback ports: validator 1 through 8545, validator 2 through 8546, validator 3 through 8547, and validator 4 through 8548. The acceptance script reaches all four through this gateway. This avoids relying on host-port forwarding directly from an internal-only validator network.

Nodes use fixed addresses in the isolated `172.28.77.0/24` bridge, advertise those addresses with `BESU_P2P_HOST`, and disable NAT discovery with `--nat-method=NONE`. If that subnet conflicts locally, update addresses, advertisements, and peers consistently.

Validator containers run as the configured non-root UID/GID. Keys retain mode 0600 and config mounts remain read-only, while only each node's data bind directory is writable. CI exports the runner's UID/GID before generating files, matching ownership without broadening key permissions. These development choices still need a reviewed production deployment design.

The verified Docker Hub release image is pinned as `hyperledger/besu:26.10.1@sha256:47aa21463213abcddc5972bc79443e6806c1c7c68e8f36ed33222882fbad8752`. JVM options `-Xms128m -Xmx512m` bound each development container's heap for CI; they are not a production capacity recommendation.

The RPC gateway uses official `nginx:stable-alpine@sha256:47928bf67eb62a1863cb08d9ecb52d3e704304ba614eaee17884204677702951`, runs as UID/GID 101, and puts PID/temporary files under `/tmp`. It mounts only `network/rpc.conf` read-only, has no validator keys, and fixes the upstream Host header to `127.0.0.1` for Besu's configured host allowlist. RPC is not authenticated and must stay loopback-only.

Node permissioning does not make transactions private. Token account eligibility is a separate application policy. All five containers share one host; the four validators are not independent failure domains.

## Executable acceptance checks

`npm run network:verify` connects to all four loopback RPC endpoints and checks:

- All four report chain ID 20261024, the generated QBFT validator membership, and a common canonical block hash with close head heights.
- Fresh test contracts execute a signed 125 dUSD payment, yield one transfer journal, and reconcile without exceptions.
- Stopping only `validator4` in the exact `clearledger-dev` Compose project leaves the other three progressing by at least two blocks and agreeing on the chain.
- Restarting validator 4 restores four-node agreement and catches it up to the observed progress.

The script has an eight-minute budget, bounded RPC/Compose operations, a best-effort restart of validator 4 on failure, and avoids logging generated keys. It does not stop other Docker projects or validators. Its journal is temporary memory state; `network:deploy` separately writes ignored reusable development-account credentials.

`.github/workflows/network.yml` runs this acceptance path on relevant pushes or manual dispatch, with a 15-minute job budget. Its cleanup removes only the workflow's ephemeral Compose network/volumes. Initial runs exposed key ownership and internal-network host-access issues; the non-root identity/data-bind configuration and separate gateway resolved those boundaries, with all gateway temporary/cache paths under `/tmp`.

The successful [network run 40189385292](https://github.com/samadalam481470sa-cmd/clearledger/actions/runs/40189385292), job `121156932986`, verified source head `0091aa306111e67855ccda6d08435e15aaae6e5a`:

- Four validators agreed at block 1 with heads `[1,1,1,1]`.
- A signed 125 dUSD transfer (`125000000` base units) settled at block 23, produced one journal row, and reconciled without exceptions.
- Validator 4 stopped at height 24; the remaining three advanced to 26 and agreed on the canonical block.
- After restart, all four caught up to height 28 and agreed again.

The complete acceptance scenario took 77,920 ms. This is scenario duration, not a throughput or settlement-latency benchmark. The regular [56-test/build workflow](https://github.com/samadalam481470sa-cmd/clearledger/actions/runs/40189385293) passed for the same source head.

Two generator/configuration tests pass for cryptographic identity/membership consistency, enodes, copied genesis, minimal round-zero RLP, permission TOML, and refusal to replace existing keys. They do not execute consensus.

Still beyond the script: loss of two validators, hostile/unapproved-peer attempts, independent-host failures, prolonged soak/load behavior, external port probing, and production fault tolerance.

References: [Besu QBFT tutorial](https://docs.besu-eth.org/private-networks/tutorials/qbft), [permissioning](https://docs.besu-eth.org/private-networks/concepts/permissioning).
