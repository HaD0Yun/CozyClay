# Security Policy

CozyClay runs locally, inside the security boundary of the user who launched it. It drives a local Blender instance over a loopback WebSocket and talks to whichever LLM provider you configured. It is not a sandbox and does not claim to be one.

## Trust model

CozyClay treats the local user account and everything writable by it as inside the same trust boundary as the CozyClay process. If an attacker can already write to your home directory, project directory, shell startup files, or CozyClay configuration, they can influence CozyClay the same way they can influence any other local developer tool. Reports that require that prior local write access are not vulnerabilities here unless they show how CozyClay itself grants that access or crosses an OS privilege boundary.

The model-facing tool surface is the boundary CozyClay actually defends:

- The embedded director session runs a fixed tool allowlist. No shell, no arbitrary filesystem write, no network tool.
- Every scene mutation is a two-phase transaction bound to an exact scene revision, with rollback on failed commit.
- The director may only mutate entities stamped as its own; hand-authored objects are refused.
- Camera plans are authorized by a SHA-256 digest over an evidence document. Caller-supplied metadata cannot authorize a plan.
- The bridge protocol is closed in both directions. Unknown messages and unknown fields fail closed.

A bug that lets model output escape any of the above is in scope.

## Reporting a vulnerability

Report privately through [GitHub Security Advisories](https://github.com/HaD0Yun/CozyClay/security/advisories/new) for this repository. Do not open a public issue.

Please include:

- A description of the issue and its impact
- Steps to reproduce, a proof of concept, or relevant logs
- Affected package, commit SHA, and configuration
- Any known mitigations

## In scope

- Escaping the director tool allowlist
- Mutating scene state without a valid revision-bound, committed transaction
- Mutating or destroying entities the director does not own
- Authorizing a camera plan without matching digest-authorized evidence
- Bridge protocol parsing that accepts a message it should reject, in either direction
- Path traversal or arbitrary file read/write through a tool parameter
- Leaking provider credentials outside the project-local agent directory

## Out of scope

- Prompt injection through scene names, file contents, or `AGENTS.md`. The model is not a trust boundary.
- The absence of a sandbox around the CozyClay process itself.
- Behavior of Pi extensions, skills, or providers you installed.
- Anything requiring the attacker to already create, modify, or replace local files, environment variables, or shell configuration.
- Malicious or wrong model output that stays inside the tool allowlist.
- Denial of service that requires trusted local input.

## Upstream Pi

`packages/{ai,agent,coding-agent,tui,server,storage}` are vendored from [earendil-works/pi](https://github.com/earendil-works/pi) unmodified. Report vulnerabilities in those packages upstream. If an upstream issue is reachable specifically through CozyClay's tool surface, report it here too so the vendored copy gets bumped.
