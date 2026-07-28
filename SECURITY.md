# Security Policy

CozyClay is a local AI agent that can drive Blender. It runs with the
permissions of the user who launched it and is not a sandbox.

## Trust model

The director has CozyClay's typed Blender tools and Pi's general tools,
including filesystem reads, shell commands, and web access. Model output can
therefore interact with the selected project directory, execute local programs,
and make network requests as the current user.

Run CozyClay only:

- in a project directory you are willing to expose to the configured model;
- under an OS account whose permissions are appropriate for agent execution;
- with provider credentials that you are willing to use for that project; and
- after reviewing third-party Pi extensions, skills, and providers you install.

Project state under `.cclay/` can contain credentials, local paths, scene
metadata, generated artifacts, and model transcripts. Do not commit or share it
without inspection.

## Transactional Blender tools

CozyClay's typed mutation tools defend the following boundaries:

- Mutations are bound to an expected scene revision.
- Typed mutations use prepare/commit with rollback on a failed commit.
- The typed tools mutate only entities stamped as CozyClay-owned unless the
  user explicitly adopts another entity.
- Camera plans are authorized by a SHA-256 digest over directing evidence.
- Bridge messages use closed schemas; unknown messages and fields fail.

These guarantees apply to the typed CozyClay tool path. The director can also
invoke Blender or scripts through its shell tool when the typed surface does not
cover an operation. Such direct commands run with the user's normal permissions
and are not made transactional by CozyClay. The system prompt tells the director
to prefer typed tools and re-inspect the scene after direct Blender changes, but
that instruction is not a security boundary.

## Reporting a vulnerability

Report vulnerabilities privately through
[GitHub Security Advisories](https://github.com/HaD0Yun/CozyClay/security/advisories/new).
Do not open a public issue.

Include:

- a description of the issue and impact;
- reproduction steps or a proof of concept;
- the affected package and commit SHA;
- relevant configuration and trimmed logs; and
- any known mitigation.

## In scope

- A typed Blender tool mutating state without its required revision check or
  committed transaction
- A typed tool mutating an entity it does not own without explicit adoption
- A camera plan accepted without matching digest-authorized evidence
- Bridge parsing that accepts an unknown or invalid message shape
- Authentication or request-correlation bypass in the local bridge
- Path traversal outside the documented boundary of a typed tool parameter
- Provider credentials leaking through CozyClay logs, bridge messages, or
  typed tool results

## Out of scope

- The documented ability of the director to read files, run shell commands, or
  access the network through Pi's general tools
- Prompt injection or malicious instructions in scene names, project files,
  web pages, prompts, skills, or `AGENTS.md`
- A malicious or incorrect model response that uses documented tool access
- The absence of an OS sandbox around CozyClay
- Behaviour of third-party Pi extensions, skills, models, or providers
- Issues that require prior write access to the user's project, home directory,
  shell configuration, or CozyClay installation, unless CozyClay granted that
  access
- Denial of service requiring trusted local input

## Upstream Pi

`packages/{ai,agent,coding-agent,tui,server,storage}` are vendored, unmodified
from [earendil-works/pi](https://github.com/earendil-works/pi). Report
vulnerabilities in those packages upstream. If an upstream issue is reachable
specifically through CozyClay's integration, report it here as well so the
vendored snapshot can be updated.
