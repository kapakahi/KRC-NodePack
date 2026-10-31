CUSTOM_BADGE_MAX_LENGTH = 10
CUSTOM_BADGE_RESERVED = {"nsfw", "draft", "modified"}


def normalize_custom_badge(value):
    """Return a valid one-badge label, "" for empty, or None for invalid."""
    text = " ".join(str(value or "").strip().split())
    if not text:
        return ""
    if len(text) > CUSTOM_BADGE_MAX_LENGTH:
        return None
    if any(not (ch.isascii() and (ch.isalnum() or ch == " ")) for ch in text):
        return None
    if text.lower() in CUSTOM_BADGE_RESERVED:
        return None
    return text
