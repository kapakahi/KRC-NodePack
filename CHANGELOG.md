# Changelog

- 2026-11-10 · Media Output items show how long their run took. API page: simpler access per profile (None / Read / Read/Write; picks only for Prompt Vault profiles and Media folders). Apps can edit values in existing Config Switcher and Word Bank presets.
- 2026-11-10 · KRC Resizer is part of KRC NodePack again (update KRC NodePack Extras too). Simpler KRC Portal ▸ API page: one row per profile with its key, and grouped resource access.
- 2026-11-10 · Media Loader: UPLOAD takes up to six files and fills the next slots. New KRC Portal ▸ API page: API profiles, each with its own key and its own access to prompts, Media folders, models and presets.
- 2026-11-08 · More API upgrades: per-area permissions in Options ▸ Network (card marks, prompt categories, prompt editing), KRC Resizer support (with NodePack Extras), and disabled KRC Resizer branches can be turned back on in exported workflows.
- 2026-11-07 · API upgrades: Model Library, Media, Loadout Kit and Prompt Vault profile support, plus a new Read only switch (on by default) in Options ▸ Network.
- 2026-11-06 · Media nodes: Options puts the slots / history and their buttons above or below the preview (Media Loader: above by default). Outside apps get KRC's palettes: each node's palette in API-format exports, and the palette list and picks in the external API.
- 2026-11-05 · Modified badges now list what changed in a hover card, and an orange dot marks each changed field (Config Switcher, Prompt Vault, LoRA Loadout / Model Library, LoRA Loadout / RefMod / Word Bank presets). Config Switcher number fields get a custom Step. Media Loader runs keep the item they were queued with; click a Media preview to mute it; Media Output can auto-download. Reset ID in More Info; faster, safer metadata editing; Model Library cleans stale records. Classic-canvas layout fixes, Media folders are real folders, and the Portal's Prompts page loses a stray profile picker.
- 2026-11-01 · Media nodes: ← / → step through slots and history; Media Loader gets a mute button; Clear asks in the button; Media Output gets a trash button for the shown file. Drop Media onto an Info Panel thumbnail (Model Library, LoRA Loadout, Prompt Vault) to make it the thumbnail.
- 2026-11-01 · Word Bank: a failed word lookup keeps the current word instead of blanking it, and can't stop a run.
- 2026-10-31 · 1.0.2 · Video no longer needs ffmpeg: ComfyUI's own video library (PyAV) now does all of it (Media uploads, Media Loader and Output, card thumbnails), with exact trims, frame rates and audio sync.
- 2026-10-31 · README: a note while the Registry review is pending.
- 2026-10-30 · 1.0.1 · Everything below since 1.0.0, plus README updates (screenshots, ComfyUI Manager install).
- 2026-10-30 · Dropdowns no longer clip letters like g, p and q; README screenshots.
- 2026-10-30 · Fix: bundle imports failed with "HTTP 500" when ComfyUI's temp folder is on another drive.
- 2026-10-30 · Bundle import: choose which Prompt Vault categories to import.
- 2026-10-30 · Example workflow renamed to "example_…"; the Media INPUT/OUTPUT toggle no longer crowds its row.
- 2026-10-30 · 1.0.0 · First public release.
