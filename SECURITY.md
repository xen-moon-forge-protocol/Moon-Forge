# Security Policy — Moon Forge Protocol

## Reporting Vulnerabilities

Moon Forge is committed to security and transparency. If you discover a vulnerability, please report it responsibly.

### How to Report

1. **GitHub Issue (preferred):** Open a [GitHub Issue](../../issues/new) with the label `security`.
   For sensitive disclosures, mark it as **confidential** or use GitHub's private vulnerability reporting feature.

2. **Anonymous Chat:** Reach out on community channels (Discord/Telegram) via a throwaway account.

Do **not** post working exploit code publicly before the issue is resolved.

### Scope

- Smart contracts (EVM portals and EVM-deployed vault/game contracts)
- Oracle logic and Merkle tree generation
- Frontend attack vectors (XSS, phishing, wallet drains)
- Economic attacks (pool drain, fee manipulation, oracle manipulation)

### Out of Scope

- Issues in third-party dependencies (report upstream)
- Theoretical attacks without a realistic exploit path

### Reward

There is no centralized bug bounty fund at launch. The protocol is community-owned.
Critical vulnerabilities that protect the protocol from significant loss will be recognized
by the community and may qualify for rewards from any future decentralized treasury.

## Disclosure Policy

Responsible disclosure: please give reasonable time to investigate and patch before any public disclosure.
The protocol is immutable after ownership is renounced — critical fixes may require a community fork.

---

*Trust the code. Verify everything.*
