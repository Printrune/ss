# Sentraspere Verse catalogue

A self-hosted, static marketplace of reusable UAS assets, behaviors, scenarios and datasets, built for the Army Training Verse Innovation Prize Challenge, Challenge III. The Government-furnished Army Verse Marketplace is not available during the prize period, so the rules allow a competitor to instantiate and demonstrate their own. This is that.

- `catalogue.json` — the index. Everything a consumer needs to discover what is here.
- `assets/*.json` — one manifest per UAS platform, conforming to `schema/uas-asset.schema.json`. `spec` holds only manufacturer-published values with sources; `derived` holds inferred values and says what they are based on; `training` is how a consuming arena binds the asset in, and never overrides `spec`.
- `scenarios/*.json` — wave and mix definitions a consumer can run.
- `index.html` — the human-readable marketplace view.

Consumers so far: Sentraspere (WebXR, virtual). A constructive 2D runner is planned.

All data is commercial-public or synthetic. No Government-furnished information. No export-controlled data.
