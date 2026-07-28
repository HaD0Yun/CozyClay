# Ask an AI coding agent to set up CozyClay

This page is for a user who wants an AI coding agent to perform the local
installation and first-run checks. Paste one of the prompts below into the
agent that controls your terminal.

Keep the agent on the same machine that will run Blender and CozyClay. Do not
paste your LLM API key into a chat transcript; use the CozyClay `/login`
command or the environment documented by your provider.

## Quick setup prompt

```text
Set up CozyClay on this machine for me.

Work step by step, verify every step, and stop if a prerequisite or command
fails. Do not use sudo, change my OS package manager configuration, edit shell
startup files, commit files, or set API keys in the environment. If Blender is
missing, install it only with my explicit approval.

1. Check that I am on macOS or Linux.
2. Check `node --version` and require Node.js 22.19 or newer.
3. Check `npm --version`.
4. Check `git --version`.
5. Find Blender 5.1.2 or newer. Check `/opt/homebrew/bin/blender`,
   `/Applications/Blender.app/Contents/MacOS/Blender`, and `blender` on PATH.
6. Clone or update https://github.com/HaD0Yun/CozyClay.git. Prefer
   `~/CozyClay`; if that path already exists and is not the CozyClay repo,
   ask me before continuing.
7. From the repository root, run `npm ci --ignore-scripts`.
8. Put launchers on my PATH without modifying shell startup files:

   mkdir -p ~/.local/bin
   ln -sfn "$PWD/scripts/cclay" ~/.local/bin/cclay

9. Run `~/.local/bin/cclay --version` and `~/.local/bin/cclay --help` and show
   me the outputs.
10. Tell me whether `~/.local/bin` is on PATH. If it is not, give me the shell
    startup line to add, but do not edit the file for me.
11. Create a project directory at `~/BlenderScenes/cozyclay-first-run` only if
    I approve it.
12. Tell me exactly what remains manual:
    - run `cclay` from the project directory;
    - answer the project-trust prompt in the TUI;
    - run `/login` or configure the chosen model provider;
    - let Blender open and initialize the project.

When finished, report:
- CozyClay repository path;
- Blender executable and version;
- Node and npm versions;
- cclay --version output;
- whether cclay is on PATH;
- any step you skipped and why;
- the exact command I should run next.

Do not run `cclay` without asking first because it opens Blender and starts an
AI agent in the project directory.
```

## Minimal prompt

Use this when the machine already has Node.js and Blender:

```text
Install CozyClay from https://github.com/HaD0Yun/CozyClay.git. Clone to
~/CozyClay or update it if it is already the CozyClay repo, run
`npm ci --ignore-scripts`, symlink `scripts/cclay` into `~/.local/bin`, then run
`~/.local/bin/cclay --version` and `~/.local/bin/cclay --help`. Do not edit my
shell startup files, do not set API keys, and do not launch Blender without
asking. Report every command result and the next command I should run.
```

## What success looks like

`cclay --version` should print the CozyClay package version, the Blender
add-on version, and a Git version:

```text
cclay cozyclay 0.0.3, add-on 0.33.0, git <revision>
```

The exact numbers can change after updates. The command must not fail with
`blender not found`, `ENOENT`, or a shell permission error.

A normal first run looks like this:

1. `cclay` opens Blender with the CozyClay add-on.
2. The TUI asks you to trust the project folder. Choose the trust option you
   intend; the agent should not silently accept it.
3. CozyClay creates `.cclay/project.json` in the project directory.
4. The director TUI shows `Blender: attached`.
5. Run `/login` if the selected model provider has no credential yet.

## Provider login

Do not let the setup agent paste provider credentials into its own transcript.
Prefer one of these:

- Run `cclay` yourself and type `/login` in the CozyClay TUI.
- Set the provider-specific environment variable locally using your provider's
  documentation.

Provider credentials and sessions live under the project's
`.cclay/pi-agent/`. Never commit `.cclay/`.

## Optional ARDY motion setup

ARDY is only required for generated character motion. Everything else works
without it.

Use this prompt only if you already have an SSH-accessible NVIDIA GPU machine:

```text
Help me configure CozyClay's optional ARDY motion host. First inspect
https://github.com/HaD0Yun/CozyClay/blob/main/scripts/ardy/README.md and
https://github.com/HaD0Yun/CozyClay/blob/main/scripts/ardy/UPSTREAM_BASE.
Confirm my GPU host over SSH, clone nv-tlabs/ardy there at the pinned commit,
install its dependencies and checkpoints, then set CCLAY_ARDY_HOST and
CCLAY_ARDY_REPO for this session. Run CozyClay's `scripts/ardy/sync-to-box`
dry run and show me every difference. Do not run `sync-to-box --apply` without
my approval. Do not guess the host, credentials, ARDY commit, or checkpoint
paths. Character motion is optional; the basic CozyClay setup must not depend
on ARDY.
```

## Safety rules to keep in the prompt

Tell the agent not to:

- set, print, or save provider API keys;
- edit shell startup files without approval;
- use `sudo` without approval;
- launch Blender without approval;
- commit `.cclay/`, `.cclay-blender.pid`, or `*.log`;
- run `scripts/ardy/sync-to-box --apply` without approval;
- claim installation succeeded without showing `cclay --version` output;
- hide a failed step behind a later successful command.

## Troubleshooting

- `command not found: cclay` — run `~/.local/bin/cclay` directly, then add
  `~/.local/bin` to PATH.
- `blender not found` — install Blender 5.1.2+ or start with
  `CCLAY_BLENDER_EXECUTABLE=/path/to/Blender cclay`.
- Blender does not initialize the project — inspect
  `.cclay-blender-attach.log` in the project directory.
- TUI opens but no provider is available — run `/login` or use
  `cclay --provider <name> --model <id>` for a provider supported by Pi.
- The setup agent says installation is done but cannot show a version output —
  treat it as not installed.
