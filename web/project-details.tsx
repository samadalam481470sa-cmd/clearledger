import type { ReactNode } from 'react';

/** Public, offline-readable product information. Never requests API credentials or chain data. */
const stack = [
  { label: 'Application UI', value: 'React 19 · TypeScript 5.9 · Vite 7' },
  { label: 'Payment service', value: 'Node.js 24 · TypeScript · ethers 6' },
  { label: 'Smart contracts', value: 'Solidity 0.8 · OpenZeppelin' },
  { label: 'Operational journal', value: 'SQLite via node:sqlite' },
  { label: 'EVM environments', value: 'Local Ganache · Besu QBFT test network' },
  { label: 'Testing', value: 'Node test runner · GitHub Actions · EVM integration' },
] as const;

const capabilities = [
  ['Signed payment instructions', 'EIP-712 authorization binds the payer, recipient, asset, amount, nonce, deadline, chain and settlement router.'],
  ['Contract policy controls', 'The token and router enforce access roles, asset rules, allowance, caps, pauses and replay protection.'],
  ['Crash-aware settlement', 'A serialized worker persists signed transaction bytes before broadcasting, preserving a recoverable reservation.'],
  ['Transfer journal & audit', 'SQLite tracks payment state, paired debit/credit entries, block provenance and operational history.'],
  ['Canonical reconciliation', 'Receipt, matching event and canonical block checks precede finalization; discrepancies are surfaced for review.'],
  ['Network testing', 'A separately launched, four-validator Hyperledger Besu QBFT network supports quorum-loss and restoration checks.'],
] as const;

const remaining = [
  ['Reorganization handling', 'A durable event indexer and audited journal rebuild/reversal path are not implemented.'],
  ['Distributed operations', 'Cross-host relayer nonce coordination, hostile-network partition testing and extended soak validation remain open.'],
  ['Production controls', 'Independent security assessment, operational key management, real-asset custody and banking integrations are not provided.'],
  ['Browser verification', 'Full interactive browser and accessibility checks are still required before a public application release.'],
] as const;

function DetailCard({ children, title }: { children: ReactNode; title: string }) {
  return <article className="details-card"><h3>{title}</h3><p>{children}</p></article>;
}

export function ProjectDetails() {
  return <div className="project-details">
    <section className="details-hero" aria-labelledby="details-hero-title">
      <div className="details-hero-copy">
        <div className="details-kicker">CLEARLEDGER / SYSTEM OVERVIEW</div>
        <h2 id="details-hero-title">Payment infrastructure built for traceability.</h2>
        <p>ClearLedger is a blockchain settlement engineering prototype: signed transfer instructions, policy-controlled smart contracts, a crash-aware settlement worker and a reconciled operational journal.</p>
        <div className="details-actions">
          <a className="details-primary" href="https://github.com/samadalam481470sa-cmd/clearledger" target="_blank" rel="noopener noreferrer">Explore source code ↗</a>
          <a className="details-secondary" href="https://github.com/samadalam481470sa-cmd/clearledger/blob/main/docs/PROJECT_DETAILS.md" target="_blank" rel="noopener noreferrer">Technical documentation ↗</a>
        </div>
      </div>
      <div className="details-hero-visual" role="img" aria-label="Settlement flow: signed authorization, policy validation, EVM settlement, receipt verification and journal reconciliation">
        <span>01 <b>Authorize</b><small>EIP-712</small></span>
        <span>02 <b>Validate</b><small>Router policy</small></span>
        <span>03 <b>Settle</b><small>EVM execution</small></span>
        <span>04 <b>Reconcile</b><small>Receipt → journal</small></span>
      </div>
    </section>

    <div className="details-warning" role="note"><strong>Engineering prototype · test assets only.</strong> The local DemoUSD token has no cash value, reserves or redemption rights. ClearLedger is not a bank, wallet custodian, audited payment network or real-money service.</div>

    <section className="details-section" aria-labelledby="details-capabilities">
      <div className="details-section-head"><div className="details-kicker">SYSTEM FEATURES</div><h2 id="details-capabilities">What the code implements</h2><p>Verified features are separated from planned infrastructure work.</p></div>
      <div className="details-card-grid">{capabilities.map(([title, description]) => <DetailCard key={title} title={title}>{description}</DetailCard>)}</div>
    </section>

    <section className="details-section" aria-labelledby="details-stack">
      <div className="details-section-head"><div className="details-kicker">BUILDING BLOCKS</div><h2 id="details-stack">Technology stack</h2></div>
      <div className="details-stack">{stack.map(entry => <div key={entry.label}><span>{entry.label}</span><strong>{entry.value}</strong></div>)}</div>
      <p className="details-small">The included <code>upstream/besu-26.10.1/</code> source is attributed upstream work, not an independently authored blockchain or consensus engine.</p>
    </section>

    <section className="details-section" aria-labelledby="details-operation">
      <div className="details-section-head"><div className="details-kicker">HOW IT WORKS</div><h2 id="details-operation">From instruction to evidence</h2></div>
      <ol className="details-steps">
        <li><strong>Authorize.</strong> The payer signs a precisely scoped EIP-712 message; the service checks its structure and authorization.</li>
        <li><strong>Reserve and dispatch.</strong> The settlement worker stores a signed transaction before sending it to the EVM so restarts can recover without inventing a second transfer.</li>
        <li><strong>Verify.</strong> Receipt, emitted settlement event, confirmation threshold and canonical block are checked.</li>
        <li><strong>Record and reconcile.</strong> The operational SQLite journal captures transfer provenance; reconciliation flags mismatches without concealing recorded history.</li>
      </ol>
    </section>

    <section className="details-section" aria-labelledby="details-readiness">
      <div className="details-section-head"><div className="details-kicker">DELIVERY READINESS</div><h2 id="details-readiness">What remains before production</h2><p>This is an engineering portfolio system, not a production payment processor.</p></div>
      <div className="details-card-grid">{remaining.map(([title, description]) => <DetailCard key={title} title={title}>{description}</DetailCard>)}</div>
    </section>

    <section className="details-section details-start" aria-labelledby="details-local">
      <div><div className="details-kicker">GET STARTED</div><h2 id="details-local">Run the complete local workflow</h2><p>Requires Node.js 24+ and npm. The local simulation creates temporary wallets and uses nonredeemable test tokens; the four-validator Besu environment is a separate Docker-based workflow.</p></div>
      <pre aria-label="Local installation commands"><code>{'npm ci\nnpm run build\nnpm test\nnpm run demo'}</code></pre>
      <p>Then open <a href="http://127.0.0.1:4317">http://127.0.0.1:4317</a> on the same computer. For RPC service setup, read the project documentation before configuring private keys or persistent storage.</p>
    </section>
    <footer className="details-footer">ClearLedger · transparent systems, explicit limits · <a href="https://github.com/samadalam481470sa-cmd/clearledger/blob/main/ROADMAP.md" target="_blank" rel="noopener noreferrer">View the project roadmap ↗</a></footer>
  </div>;
}
