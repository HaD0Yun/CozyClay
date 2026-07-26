# Licenses

CozyClay's own code is GPL-3.0-or-later ([`../LICENSE`](../LICENSE)). This directory holds the licenses of the third-party code the repository carries or derives from, because those terms survive CozyClay's own licensing and cannot be replaced by it.

| file | applies to | why it is still here |
|---|---|---|
| [`MIT-pi.txt`](MIT-pi.txt) | `packages/{ai,agent,coding-agent,tui,server,storage}` — vendored upstream [Pi](https://github.com/earendil-works/pi), unmodified | MIT is GPL-compatible, so this code may be distributed as part of a GPL work, but its copyright notice and permission notice must be retained. Those files stay MIT: taking one out of CozyClay carries MIT terms, not GPL |
| [`Apache-2.0-ardy.txt`](Apache-2.0-ardy.txt) | `scripts/ardy/upstream-patches/*.patch` — modifications to files [ARDY](https://github.com/nv-tlabs/ardy) owns | a patch against Apache-2.0 sources is a derivative work of them, so it carries Apache-2.0, including the attribution and modification-notice requirements of section 4. Apache-2.0 is compatible with GPLv3 but not GPLv2, which is why CozyClay is GPLv3 and not GPLv2 |

Everything else under `scripts/ardy/` (`interactive_demo/`, `tests/`, `cclay_constrained_generate.py`, `cclay_sequence_generate.py`) is CozyClay's own work: it imports ARDY without deriving from it, and is GPL-3.0-or-later like the rest of this repository.
