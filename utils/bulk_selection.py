"""Common bounded ID snapshot validation for provider operations."""


def validate_card_ids(raw):
    if not isinstance(raw, list) or not 1 <= len(raw) <= 10000:
        raise ValueError("Select between 1 and 10000 cards per operation.")
    if any(not isinstance(item, str) or not item.strip() or len(item) > 256 for item in raw):
        raise ValueError("Invalid card ID.")
    return list(dict.fromkeys(raw))
