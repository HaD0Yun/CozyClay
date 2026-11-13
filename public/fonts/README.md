# Bundled fonts

The `.woff2` files in this directory are redistributed with CozyClay under the
SIL Open Font License 1.1. Each family has its upstream OFL text beside the
font files. The Inter and Instrument Serif files are still in use: `index.html`
loads `inter-latin.woff2` and `instrument-serif-latin.woff2`, and `public/sw.js`
precaches `inter-latin.woff2`.

| Files | Family | Upstream release | Copyright | Licence |
| --- | --- | --- | --- | --- |
| `ibm-plex-sans-400-latin.woff2`, `ibm-plex-sans-500-latin.woff2`, `ibm-plex-sans-600-latin.woff2` | IBM Plex Sans | [`@ibm/plex-sans@1.1.0`](https://github.com/IBM/plex/releases/tag/%40ibm/plex-sans%401.1.0) ([asset](https://github.com/IBM/plex/releases/download/%40ibm/plex-sans%401.1.0/ibm-plex-sans.zip)) | Copyright (c) 2017 IBM Corp. with Reserved Font Name "Plex" | [OFL-1.1](IBM-Plex-Sans-OFL.txt) |
| `jetbrains-mono-400-latin.woff2`, `jetbrains-mono-500-latin.woff2` | JetBrains Mono | [`v2.304`](https://github.com/JetBrains/JetBrainsMono/releases/tag/v2.304) ([asset](https://github.com/JetBrains/JetBrainsMono/releases/download/v2.304/JetBrainsMono-2.304.zip)) | Copyright 2020 The JetBrains Mono Project Authors | [OFL-1.1](JetBrains-Mono-OFL.txt) |
| `inter-latin.woff2` | [Inter](https://github.com/rsms/inter) | existing bundle | Copyright (c) 2016 The Inter Project Authors | [OFL-1.1](Inter-OFL.txt) |
| `instrument-serif-latin.woff2`, `instrument-serif-italic-latin.woff2` | [Instrument Serif](https://github.com/Instrument/instrument-serif) | existing bundle | Copyright 2022 The Instrument Serif Project Authors | [OFL-1.1](InstrumentSerif-OFL.txt) |

The IBM Plex Sans files are the upstream Latin1 webfont subsets. Korean text
continues through the Pretendard and Noto Sans KR fallbacks in `--sans`.
Under the OFL, a modified copy may not use the Reserved Font Name, so if a
subset is ever renamed or edited beyond subsetting, check clause 3 before
shipping it.
