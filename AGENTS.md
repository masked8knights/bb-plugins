# Agent instructions

## Plugin documentation

All new plugins must include screenshots in a staged environment before they
are handed off.

- Show the plugin's primary workflow in a readable BB-style staged preview.
- For plugins without a frontend, stage the main settings, host surface, or CLI
  workflow instead.
- Add the preview to the plugin README under `## Staged preview` with a relative
  image link and a note that the data is illustrative.
- Add the plugin metadata and scene to
  `scripts/generate-plugin-previews.mjs`. Then run:

  ```sh
  node scripts/generate-plugin-previews.mjs
  ```

- Keep the generated asset at
  `packages/<plugin>/assets/staged-preview.svg`.
- Keep preview text and controls readable at README width. Use deterministic
  data so the preview does not depend on a live BB session.

Before handoff, verify the generated SVGs and README links:

```sh
for file in packages/*/assets/staged-preview.svg; do xmllint --noout "$file" || exit 1; done
for readme in packages/*/README.md; do base=${readme%/README.md}; test -f "$base/assets/staged-preview.svg" || exit 1; done
git diff --check
```
