# Asset provenance register

This register records the public-source review of Cognivoy's committed visual
assets. It supplements `LICENSE`, `NOTICE`, `MODIFICATIONS.md`, and
`THIRD_PARTY_NOTICES.md`; it does not grant rights in third-party trademarks.

## Audit snapshot

- Audit date: 2026-09-04
- Original review scope: 180 visual assets (114 PNG and 66 SVG files), before
  the public snapshot exclusions described below
- Upstream reference: HKUDS/DeepTutor commit
  `4328bc71b0f780b926bbb2cdfcc58688e80b5add`
- Upstream license: Apache-2.0
- Method: Git-blob comparison, visual contact-sheet review, OCR privacy scan,
  reference scan, and raster metadata inspection

At the audited revision, 65 assets are byte-identical to files at the same path
in the upstream reference, 28 occupy upstream paths but contain Cognivoy-local
changes, and 87 are Cognivoy-only files. The maintainer's records attribute the local-only
asset additions to the Cognivoy maintainer. Unless a narrower notice is present,
the maintainer distributes those original and modified Cognivoy assets under
the repository's Apache-2.0 license.

## Asset groups

| Paths | Provenance and status |
| --- | --- |
| `web/public/**` | 40 files byte-identical to the Apache-2.0 upstream reference. Provider logos identify compatible services only; their owners retain trademark rights. |
| `assets/figs/**` | Mix of upstream Apache-2.0 screenshots/diagrams and Cognivoy modifications. One README screenshot was privacy-redacted as described below. |

The public snapshot excludes the archived frontend, historical screenshot
archive and development regression screenshots. Those exclusions reduce the
asset count relative to the original review. No private Git history is included.

## Privacy and safety review

- No embedded GPS, author, copyright, or comment metadata was detected in the
  tracked PNG files.
- OCR found no API keys, bearer tokens, or real email addresses. Values such as
  `you@example.com` are synthetic UI examples.
- `assets/figs/web-1.4.6+/home/08-subagent demo with claude code.png` originally
  contained an upstream developer's local `/Users/...` path. On 2026-09-04 it
  was edited with OpenAI's image-editing service to replace only that path with
  `/workspace/Cognivoy`; the upstream screenshot remains the source work.
- Two unused upstream roster SVGs containing embedded GitHub user avatars were
  removed from the public tree and are not included in this snapshot's history.

## Trademark notice

Cognivoy, DeepTutor, OpenAI, Anthropic, Azure, Gemini, and other product names
or logos are or may be trademarks of their respective owners. Their appearance
in screenshots or provider selectors is solely descriptive and does not imply
affiliation, sponsorship, or endorsement. The Apache License does not grant a
license to use third-party trademarks beyond applicable law.

Future asset changes must follow `ASSET_POLICY.md` and update this register or
the relevant directory-level notice.
