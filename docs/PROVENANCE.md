# Source provenance

## Application and adaptations

ClearLedger's application, tests, and documentation outside `upstream/` were developed for this project with AI assistance. They use the root MIT license. This does not imply independent authorship of attributed third-party adaptations.

The router's address-only EOA/ERC-1271 signature checker adapts [OpenZeppelin Contracts 5.4.0 `SignatureChecker`](https://github.com/OpenZeppelin/openzeppelin-contracts/blob/v5.4.0/contracts/utils/cryptography/SignatureChecker.sol): ECDSA `tryRecover` for addresses without code, otherwise STATICCALL with a successful return of at least one exact padded magic-value word. Source comments identify the adaptation, and [the OpenZeppelin MIT notice](../licenses/OpenZeppelin-MIT.txt) preserves its attribution. This small adaptation retains the Paris EVM target because importing the full 5.4 library also imports a Cancun-only MCOPY implementation. It is included in the application count, not claimed as independently invented and not part of the Besu snapshot.

Historical artifact hashes and maintenance records remain evidence for their recorded source version. Adding this checker changes the router ABI/bytecode; prior router hashes do not identify the updated deployment.

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

`npm run source:count` writes `docs/source-count.json`, separating application (`original` in the report) and upstream physical/nonblank source lines. The application bucket includes the clearly attributed signature-checker adaptation described above. Comments and tests in recognized source files are included. The counter excludes dependency installations, documentation, JSON, lockfiles, generated files, binaries, databases, and build output. The Besu snapshot alone contributes 622,912 nonblank source lines.

## Packages

`package.json` pins direct package versions and `package-lock.json` records dependency integrity hashes. OpenZeppelin supplies foundational token, access-control, and cryptographic primitives; ethers provides signing and EVM clients; solc compiles contracts; React supplies the UI; Ganache/memdown supply the temporary development chain. Node provides SQLite.

Third-party licenses remain their own and are not replaced by ClearLedger's MIT license.
