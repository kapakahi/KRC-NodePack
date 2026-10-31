"""KRC Model Library backend.

Stage 1 scope: the generic model metadata record and its normalizer/migration.
Schema contract: KRC_MODEL_METADATA_SCHEMA.md (repo root) is the source of truth;
this package must follow it, not the other way around.

LoRA Loadout remains the sole owner/writer of LoRA records. This package never
mints a generic record for a LoRA (krcRecordKind "model" vs "lora").
"""
