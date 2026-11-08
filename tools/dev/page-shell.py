#!/usr/bin/env python3
"""One-off generator for the search-facing article pages.

Each page is plain static HTML (no bundle) so it stays crawlable and cheap.
The shell (head, nav, footer, shared CSS link) lives here; the body of each
page is authored in tools/dev/pages/<slug>.html and inlined.
Run: python3 tools/dev/page-shell.py
"""
import json, os, re, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
PAGES_DIR = os.path.join(os.path.dirname(__file__), "pages")

NAV = """        <nav>
          <a href="/app/">Try it</a>
          <a href="/greybox-to-video/">Greybox to video</a>
          <a href="/previs-software/">Previs software</a>
          <a href="/ai-camera-control/">Camera control</a>
          <a href="https://github.com/HaD0Yun/CozyClay">GitHub</a>
        </nav>"""

FOOTER = """    <footer class="site">
      <div class="wrap">
        <p>
          <a href="https://github.com/HaD0Yun/CozyClay">Source code (AGPL)</a> ·
          <a href="https://www.npmjs.com/package/cozyclay">npm</a> ·
          <a href="/privacy/">Privacy</a>
        </p>
        <p>CozyClay is not affiliated with or endorsed by NVIDIA, ByteDance, Kuaishou, Google or Unity Technologies.</p>
      </div>
    </footer>"""


def shell(meta, body):
    url = "https://cozyclay.org" + meta["path"]
    image = meta.get("image", "https://cozyclay.org/media/cozyclay-demo-poster.jpg")
    ld = {
        "@context": "https://schema.org",
        "@type": meta.get("type", "Article"),
        "headline": meta["headline"],
        "description": meta["description"],
        "image": image,
        "mainEntityOfPage": url,
        "datePublished": meta["published"],
        "dateModified": meta.get("modified", meta["published"]),
        "author": {"@type": "Organization", "name": "CozyClay", "url": "https://cozyclay.org/"},
        "publisher": {"@type": "Organization", "name": "CozyClay", "logo": {"@type": "ImageObject", "url": "https://cozyclay.org/media/cozyclay-logo.png"}},
    }
    if meta.get("type") == "WebPage":
        ld.pop("headline"); ld.pop("author"); ld.pop("publisher")
        ld["name"] = meta["headline"]
    return f"""<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <meta name="description" content="{meta['description']}" />
    <meta name="theme-color" content="#232323" />
    <link rel="canonical" href="{url}" />
    <link rel="icon" type="image/png" sizes="192x192" href="/icons/icon-192.png" />
    <link rel="icon" href="/favicon.ico" sizes="48x48 96x96 192x192" />
    <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
    <link rel="stylesheet" href="/site.css" />

    <meta property="og:type" content="article" />
    <meta property="og:site_name" content="CozyClay" />
    <meta property="og:title" content="{meta['og_title']}" />
    <meta property="og:description" content="{meta['description']}" />
    <meta property="og:url" content="{url}" />
    <meta property="og:image" content="{image}" />
    <meta property="og:image:width" content="1920" />
    <meta property="og:image:height" content="1080" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="{meta['og_title']}" />
    <meta name="twitter:description" content="{meta['description']}" />
    <meta name="twitter:image" content="{image}" />

    <title>{meta['title']}</title>
    <script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{{"token": "6a4384d1375d4ffc8a30a6346a8ad1a0"}}'></script>
    <script type="application/ld+json">
{json.dumps(ld, indent=6, ensure_ascii=False)}
    </script>
  </head>
  <body>
    <header class="site">
      <div class="wrap">
        <a class="brand" href="/">CozyClay</a>
{NAV}
      </div>
    </header>

    <main class="wrap article">
{body}
    </main>

{FOOTER}
  </body>
</html>
"""


def main():
    for name in sorted(os.listdir(PAGES_DIR)):
        if not name.endswith(".html"):
            continue
        src = open(os.path.join(PAGES_DIR, name), encoding="utf-8").read()
        head, body = src.split("\n---\n", 1)
        meta = json.loads(head)
        out_dir = os.path.join(ROOT, meta["path"].strip("/"))
        os.makedirs(out_dir, exist_ok=True)
        with open(os.path.join(out_dir, "index.html"), "w", encoding="utf-8") as f:
            f.write(shell(meta, body.rstrip("\n")))
        print("wrote", meta["path"])


if __name__ == "__main__":
    main()
