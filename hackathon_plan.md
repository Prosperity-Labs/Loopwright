# Arbitrum Open House Dubai — Hackathon Plan

**Event:** Arbitrum Open House Dubai Online Buildathon
**Buildathon:** April 23 – May 14, 2026
**Founder House:** May 28 – 31, 2026
**Prize Pool:** $800K+ across tracks, $1M Robinhood Chain bounty
**Tracks:** Payments, DeFi, RWAs, Privacy, Consumer, Arbitrum-native Tooling

---

## The Idea: ZK-Verified AI Intent Solver on Arbitrum

**Name:** IntentProof (working title)

**One-liner:** AI agents propose transaction intents, ZK proofs verify the agent followed policy, Arbitrum executes trustlessly.

**The thesis (from Brian Seong / Miden):**
> AI proposes → TEE preserves privacy → ZK enforces boundaries → Network verifies.
> Crypto doesn't compete with AI. It makes AI safe.

We build the **proof layer between AI and on-chain execution**. The user tells an LLM what they want ("swap my USDC for the best yield on Arbitrum"), the LLM proposes a transaction intent, a ZK circuit proves the intent follows the user's policy constraints, and the signed proof executes on Arbitrum. The user never trusts the AI — they verify it.

---

## Why This Wins (Mapped to Judging Criteria)

### 1. Execution — Functional MVP on Arbitrum
- Smart contracts deployed on Arbitrum One / Sepolia
- Working demo: user types natural language → AI proposes intent → ZK proof generated → tx executes
- Clean repo, tests, documentation

### 2. Problem-Solution Fit — Why Arbitrum Specifically
- **Stylus** — ZK proof verification in Rust/C, not Solidity. Cheaper gas for heavy computation.
- **Timeboost** — Priority ordering for intent settlement. AI-proposed intents land faster.
- **Arbitrum Orbit** — Could deploy as a custom chain specifically for ZK-verified AI intents.
- This is NOT generic. It specifically leverages Arbitrum's unique capabilities.

### 3. Traction/Potential — Beyond the Hackathon
- Connects to Loopwright vision (autonomous agents need verified execution)
- Connects to Engram (session memory for intent history)
- Clear path: hackathon MVP → protocol → integration with DeFi composability

---

## Architecture

```
┌─────────────────────────────────────────────┐
│                  USER                        │
│  "Swap 1000 USDC for best yield on Arb"     │
└──────────────────┬──────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────┐
│            OFF-CHAIN: LLM AGENT             │
│                                             │
│  1. Parse user intent (natural language)     │
│  2. Query on-chain state (DeFi protocols)    │
│  3. Propose optimal transaction path         │
│  4. Generate TransactionIntent struct        │
│     - target contracts                       │
│     - calldata                               │
│     - constraints (max slippage, min yield)  │
│     - user policy hash                       │
│                                             │
│  Model: Claude API / local LLM              │
└──────────────────┬──────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────┐
│          ZK PROOF GENERATION                │
│                                             │
│  Circuit proves (without revealing intent): │
│  1. Intent satisfies user's policy          │
│     - slippage ≤ user's max                 │
│     - target contracts are whitelisted      │
│     - amount ≤ user's spending limit        │
│  2. AI reasoning followed constraints       │
│     - hash of LLM output matches intent     │
│     - no unauthorized side effects          │
│  3. Intent is valid for current state       │
│     - references real pool/vault addresses  │
│     - amounts are feasible given balances   │
│                                             │
│  Stack: SP1 / Risc0 / Noir / Circom        │
└──────────────────┬──────────────────────────┘
                   │ Proof + Signed Tx
                   ▼
┌─────────────────────────────────────────────┐
│          ON-CHAIN: ARBITRUM                 │
│                                             │
│  IntentVerifier.sol (Stylus/Rust):          │
│  1. Verify ZK proof on-chain               │
│  2. Decode intent from proof public inputs  │
│  3. Execute transaction if proof valid      │
│  4. Emit IntentExecuted event               │
│                                             │
│  PolicyRegistry.sol:                        │
│  - Users register spending policies         │
│  - Max amounts, whitelisted contracts,      │
│    slippage limits, time constraints        │
│  - Policies are hashed, stored on-chain     │
│                                             │
│  IntentHistory.sol:                         │
│  - Log of all verified intents              │
│  - Queryable by user, by AI agent, by type  │
│  - Feeds back into LLM context             │
│                                             │
│  Deployed on: Arbitrum One / Sepolia        │
│  Written in: Stylus (Rust) for ZK verify   │
└─────────────────────────────────────────────┘
```

---

## Tech Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| **LLM** | Claude API (Anthropic) | Best reasoning for complex DeFi intent generation. Tool use for on-chain queries. |
| **ZK Proofs** | SP1 (Succinct) or Noir (Aztec) | SP1: write circuits in Rust, fast proving. Noir: concise DSL for constraint systems. Both have Arbitrum-friendly verifiers. |
| **Smart Contracts** | Stylus (Rust) on Arbitrum | ZK verification is computationally heavy — Stylus runs Rust/WASM, 10-100x cheaper than Solidity for this. |
| **Frontend** | Next.js + wagmi + viem | Standard Web3 frontend. Chat interface for natural language intents. |
| **Intent Solver** | Bun/TypeScript | Parse LLM output, format intent struct, coordinate proof generation. Same stack as Loopwright. |
| **On-chain State** | Arbitrum One + Subgraph | Query DeFi protocol state for intent generation. |

---

## What the ZK Circuit Proves

This is the core innovation. The ZK proof says: "this AI-generated transaction satisfies the user's policy" without revealing:
- The user's full policy (privacy)
- The AI's reasoning process (IP protection)
- The exact parameters until execution (MEV protection)

**Public inputs (visible on-chain):**
- Policy hash (commitment to user's constraints)
- Intent hash (commitment to the transaction)
- Proof that policy_hash validates intent_hash

**Private inputs (hidden):**
- User's full policy (max slippage, whitelisted contracts, spending limits)
- LLM's proposed transaction details
- The matching logic between policy and intent

**What the circuit constrains:**
```
assert(intent.slippage <= policy.max_slippage)
assert(intent.target IN policy.whitelisted_contracts)
assert(intent.amount <= policy.spending_limit)
assert(intent.amount <= user.balance)
assert(hash(intent) == public_intent_hash)
assert(hash(policy) == public_policy_hash)
```

---

## User Flow (Demo Script)

1. **User connects wallet** on Arbitrum
2. **User sets policy**: "Max 2% slippage, only interact with Aave/GMX/Camelot, max $5000 per transaction"
   → Policy hashed and stored in PolicyRegistry.sol
3. **User types intent**: "Put my idle USDC into the highest yield opportunity on Arbitrum"
4. **LLM agent**:
   - Queries on-chain state (Aave rates, GMX GLP yield, Camelot LP APRs)
   - Reasons about best option given user's policy constraints
   - Proposes: "Deposit 1000 USDC into Aave v3 on Arbitrum at 4.2% APY"
   - Generates TransactionIntent struct
5. **ZK proof generated**: proves intent satisfies user's policy without revealing policy details
6. **User reviews** the proposed intent (optional — can auto-execute for trusted policies)
7. **Proof + signed tx submitted** to IntentVerifier on Arbitrum
8. **On-chain**: verify proof → execute transaction → emit event
9. **Intent logged** to IntentHistory.sol → feeds back into LLM context for next time

---

## Hackathon Sprint Plan (3 Weeks: Apr 23 – May 14)

### Week 1 (Apr 23–30): Foundation

| Day | Agent 1 | Agent 2 |
|-----|---------|---------|
| **1-2** | Smart contracts: PolicyRegistry.sol + IntentVerifier.sol in Stylus (Rust). Deploy to Arbitrum Sepolia. | ZK circuit: policy verification circuit in SP1/Noir. Prove intent satisfies policy constraints. |
| **3-4** | IntentHistory.sol + subgraph for querying past intents. On-chain state query helpers. | LLM agent: Claude API integration. Natural language → structured TransactionIntent. Tool use for on-chain queries. |
| **5-7** | Integration: LLM output → ZK proof input → on-chain verification. End-to-end happy path. | Frontend scaffold: Next.js + wagmi. Chat interface. Wallet connect. Policy setup UI. |

### Week 2 (May 1–7): Integration + Polish

| Day | Agent 1 | Agent 2 |
|-----|---------|---------|
| **8-9** | Real DeFi integration: query actual Aave/GMX/Camelot on Arbitrum. Real yields, real pools. | Proof optimization: proving time, verification gas cost. Benchmark Stylus vs Solidity verifier. |
| **10-11** | Intent solver: handle multi-step intents ("swap then deposit"). Transaction batching. | Frontend: intent history view, policy management, proof status display. |
| **12-14** | Security: edge cases, malicious intents, policy bypass attempts. Fuzz testing. | Documentation: README, architecture diagram, demo video script. |

### Week 3 (May 8–14): Demo + Submission

| Day | Agent 1 | Agent 2 |
|-----|---------|---------|
| **15-16** | Deploy to Arbitrum One (mainnet or production Sepolia). Verify all contracts. | Record demo video. Write submission. |
| **17-18** | Stress test: multiple users, multiple intents, concurrent proof generation. | Polish frontend. Fix UX issues from testing. |
| **19-21** | Final testing. Bug fixes. Ensure everything works for live demo. | Submit. Prepare pitch for Founder House (May 28–31). |

---

## Competitive Positioning

**Why this beats other submissions:**

1. **It's not another chatbot.** It's infrastructure. A protocol that any AI agent can use to execute on-chain trustlessly.
2. **Stylus is the differentiator.** ZK verification in Rust on Arbitrum is new and underused. Judges will notice.
3. **Privacy-preserving.** User policies stay private. MEV protection. This hits the "Privacy" track.
4. **DeFi composability.** Intents can compose across any Arbitrum DeFi protocol. Hits the "DeFi" track.
5. **AI + Crypto thesis.** Directly implements Brian Seong's framework. Judges at Arbitrum are thinking about this.
6. **Beyond the hackathon.** Clear path to protocol → DAO → token. Not a throwaway project.

**Tracks we qualify for:**
- **DeFi** — AI-optimized yield strategies with ZK verification
- **Privacy** — ZK proofs hide policy details and intent parameters
- **Arbitrum-native Tooling** — Stylus for ZK verification, Timeboost for intent settlement
- **Consumer** — Natural language interface makes DeFi accessible

---

## Relationship to Prosperity Labs Stack

| Component | Role in Hackathon |
|-----------|------------------|
| **Engram** | Session memory for intent history. Agent remembers what yield strategies worked before. |
| **Loopwright** | Self-correcting loop: if intent fails (slippage too high), agent retries with adjusted parameters. |
| **Noodlbox** | Code graph for the smart contract codebase. Understand blast radius of contract changes. |
| **Memgraph** | Temporal graph of intent patterns over time. "Users who did X then did Y." |

The hackathon is a vertical slice of the Prosperity Labs thesis: **autonomous agents need verified execution, memory, and self-correction.**

---

## Open Questions

- **ZK framework choice:** SP1 (Rust, fast, good Arbitrum support) vs Noir (cleaner DSL, Aztec ecosystem) vs Circom (battle-tested, larger community). Leaning SP1 for Stylus alignment.
- **TEE inclusion:** Brian's diagram includes TEE. Worth adding for full architecture, or scope creep for a hackathon? Leaning skip for MVP, mention in roadmap.
- **Robinhood Chain bounty:** $1M pool specifically for Robinhood Chain testnet. Could we deploy on both Arbitrum One and Robinhood Chain to qualify for both prize pools?
- **Team size:** 2 agents + 1 human. Is that enough for 3 weeks? Yes if prompts are tight and scope is disciplined.

---

## Resources

- [Arbitrum Open House](https://openhouse.arbitrum.io/)
- [What winning teams do differently](https://dev.to/arbitrum/what-winning-arbitrum-open-house-teams-do-differently-18f8)
- [Robinhood Chain $1M bounty](https://blog.arbitrum.foundation/builders-block-011-robinhood-chain-launches-testnet-commits-1m-to-builders/)
- [Stylus documentation](https://docs.arbitrum.io/stylus/stylus-gentle-introduction)
- [SP1 (Succinct)](https://docs.succinct.xyz/)
- [Noir (Aztec)](https://noir-lang.org/)

---

*IntentProof — Making AI Trustworthy On-Chain — Prosperity Labs × Arbitrum Open House Dubai 2026*
