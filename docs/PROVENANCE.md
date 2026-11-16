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

The retained release ZIP matched the SHA-256 above and carried the recorded upstream commit ID in its archive comment. All 6,738 file paths and all file bytes matched the tracked snapshot after removing the ZIP's top-level directory from each path. Eighteen ZIP entries carried a Unix user-execute bit and are tracked with Git mode `100644`. The Besu code and tests retain their upstream attribution. ClearLedger's network acceptance uses the corresponding published container image. Besu's upstream build and test suite remain outside that acceptance scope.

Regular CI requires the committed `upstream` Git tree to match `c4160c74616c6ba77a4575d517bc6cf1dc9c2d6b` from the initial public ClearLedger commit. This pins all committed paths, bytes and modes under `upstream/`. Update the pin when reviewing a snapshot replacement. The tree ID identifies ClearLedger's vendored copy. The archive SHA-256 identifies the downloaded ZIP.

## Counting

`npm run source:count` writes `docs/source-count.json`, separating application (`original` in the report) and upstream physical/nonblank source lines. CI runs `npm run source:count -- --check` to compare the recalculated report with the committed report without rewriting it. The comparison accepts CRLF line endings and requires the other bytes to match. The application bucket includes the clearly attributed signature-checker adaptation described above. Comments and tests in recognized source files are included. The counter excludes dependency installations, documentation, JSON, lockfiles, generated files, binaries, databases, and build output. The Besu snapshot alone contributes 622,912 nonblank source lines.

## Packages

`package.json` pins direct package versions and `package-lock.json` records dependency integrity hashes. OpenZeppelin supplies foundational token, access-control, and cryptographic primitives; ethers provides signing and EVM clients; solc compiles contracts; React supplies the UI; Ganache/memdown supply the temporary development chain. Node provides SQLite.

Third-party licenses remain their own and are not replaced by ClearLedger's MIT license.
