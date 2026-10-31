"""The one KRC NSFW rating, shared by LoRA and generic model records.

Civitai rates content with single flags — PG 1, PG-13 2, R 4, X 8, XXX 16 (32 is
Blocked, a moderation state) — and reports a version's ``nsfwLevel`` as the OR of
every image's flag (R|X|XXX|Blocked = 60). A KRC record stores ONE rating: the
highest content flag (0 = unrated). A Civitai fetch auto-tags a record NSFW at R and
above, or when Civitai flags the whole model.
"""

NSFW_RATINGS = ((0, "None"), (1, "PG"), (2, "PG-13"), (4, "R"), (8, "X"), (16, "XXX"))
NSFW_AUTO_TAG_MIN = 4  # R
_CONTENT_FLAGS = 1 | 2 | 4 | 8 | 16


def nsfw_rating(value):
    """The highest content flag in ``value`` (an int mask; Blocked dropped), else 0."""
    try:
        number = int(value)
    except (TypeError, ValueError):
        return 0
    mask = number & _CONTENT_FLAGS if number > 0 else 0
    return 1 << (mask.bit_length() - 1) if mask else 0


def civitai_nsfw(version, model=None, images=()):
    """(rating, auto_nsfw) for a Civitai by-hash response: the rating covers the
    version's mask and every image's level; auto-tag at R+ or a model-wide flag."""
    version = version if isinstance(version, dict) else {}
    model = model if isinstance(model, dict) else {}
    mask = 0
    for value in (version.get("nsfwLevel"), *(image.get("nsfwLevel") for image in images if isinstance(image, dict))):
        if isinstance(value, int) and value > 0:
            mask |= value
    rating = nsfw_rating(mask)
    return rating, bool(model.get("nsfw") is True or rating >= NSFW_AUTO_TAG_MIN)
