"""The KRC bundle: one archive type with sections (UNIFIED_BUNDLE_GAMEPLAN.md).

container.py  the archive marker + SectionArchive (a section's view of its folder)
sections.py   the section registry (each node registers its own; kits come from the kit registry)
export.py     build a bundle from chosen sections (+ linked presets)
routes.py     /krc/bundle/*
"""
