# Source provenance

## Original application

ClearLedger's contracts, TypeScript service, React interface, tests, and documentation outside `upstream/` were created for this project with AI assistance. They use the root MIT license.

## Besu

- Project: Besu, an open-source Ethereum execution client.
- Repository: https://github.com/besu-eth/besu
- Release: **26.10.1**.
- Commit: `e83703cdf863093b98ebe1d8719cd77cdf8639d8`.
- Download: https://github.com/besu-eth/besu/archive/refs/tags/26.10.1.zip
- Archive SHA-256: `f363f1b7e44e4c65d9e5aa212f21d90a89b235c48ba6225bb240eb764683b25b`.
- Location: `upstream/besu-26.10.1/`.
- Original `LICENSE` and `NOTICE` are preserved there.

The snapshot is unmodified. Its code and tests are not claimed as original ClearLedger work, and its own build/test suite has not been run here. Development-network configuration references the corresponding published container image.

## Counting

`npm run source:count` writes `docs/source-count.json`, separating original and upstream physical/nonblank source lines. Comments and tests in recognized source files are included. It excludes dependency installations, documentation, JSON, lockfiles, generated files, binaries, databases, and build output. The Besu snapshot alone contributes 622,912 nonblank source lines.

## Packages

`package.json` pins direct package versions and `package-lock.json` records dependency integrity hashes. OpenZeppelin supplies foundational token, access-control, and cryptographic primitives; ethers provides signing and EVM clients; solc compiles contracts; React supplies the UI; Ganache/memdown supply the temporary development chain. Node provides SQLite.

Third-party licenses remain their own and are not replaced by ClearLedger's MIT license.
