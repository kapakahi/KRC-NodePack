"""The external API's KRC Resizer routes (KRC_EXTERNAL_API.md "KRC Resizer"). These own the
routes (behind the switch and key), the sources (ext_api_sources.py), the handles and their
staleness, and the limits; utils/resizer_provider.py owns everything about the node: the
fingerprint, the preview frames it keeps, and crop_state. The Resizer is part of NodePack
(moved back from KRC NodePack Extras 2026-11-10), so the provider is called directly.

All reads, by classification: preparing a preview only reads the source file and fills a
bounded in-memory preview store that nothing else reads (no file, record, setting or
workflow is written), so it needs the switch and key and no write area.

Each function returns (status, body); a frame answers JPEG bytes as its body.
"""
MAX_SETTINGS_BYTES = 64 * 1024

_SOURCE_STATUS = {"bad_request": 400, "not_found": 404, "unsupported": 422, "too_large": 413, "busy": 429}
_SOURCE_CODE = {"unsupported": "unsupported_source"}


def _error(status, code, message, **extra):
    return status, {"error": code, "message": message, **extra}


def _provider(_capability=""):
    from .resizer_provider import PROVIDER

    return PROVIDER


def _source_error(err):
    return _error(_SOURCE_STATUS.get(err.code, 400), _SOURCE_CODE.get(err.code, err.code), str(err))


def _public(meta):
    """A preview as the API answers it (the provider's record, minus internals)."""
    return {key: value for key, value in meta.items() if key != "identity"}


def _source_allowed(spec):
    """Whether the caller may read this source (ext_api_policy): a Media item through its
    folder; a Load Image file by name only with the profile's ``fileSources``. Checked when a
    preview is made AND every time one is read, so a handle (or a source named in a
    caller-supplied workflow) never reaches what the caller can't."""
    from . import ext_api_policy as policy

    if policy.current() is None:
        return True
    if spec.get("kind") == "media":
        from .media import media_store as store
        try:
            record = store.get(spec.get("id", ""))
        except store.MediaError:
            record = None
        return record is not None and policy.media_item_readable(record)
    return policy.current().file_sources


def _fresh(provider, handle):
    """(meta, None) for a live preview whose source is unchanged, else (None, error)."""
    from .ext_api_sources import SourceError, identity

    handle = str(handle or "").strip()
    meta = provider.get(handle) if handle else None
    if not meta or not _source_allowed(meta.get("source") or {}):
        return None, _error(404, "not_found", "No preview has that handle (it expired, or the server restarted): prepare it again.")
    try:
        current = identity(meta["source"])
    except SourceError:
        current = None
    if current != meta.get("identity"):
        provider.drop(handle)
        return None, _error(410, "stale", "The source changed (or is gone) since this preview was made: prepare it again.",
                            source=meta["source"])
    return meta, None


def prepare(payload):
    """POST /krc/ext/v1/resizer/previews {source}: the preview of a source, made now (201) or
    the existing one when the source is unchanged (200)."""
    from .ext_api_sources import SourceError, handle_for, identity, loading, normalize

    provider = _provider("resizer.previews")
    if not isinstance(payload, dict) or set(payload) - {"source"}:
        return _error(400, "bad_request", "The body is {\"source\": {...}}")
    try:
        spec = normalize(payload.get("source"))
        if not _source_allowed(spec):
            if spec["kind"] == "media":
                raise SourceError("not_found", "No Media item has that id, or its file is gone")
            from . import ext_api_policy as policy
            policy.require_file_sources()
        current = identity(spec)
    except SourceError as err:
        return _source_error(err)
    handle = handle_for(current)
    meta = provider.get(handle)
    if meta and meta.get("identity") == current:
        return 200, {"preview": _public(meta), "prepared": False}
    try:
        with loading(spec) as source:
            source.handle = handle
            meta = provider.prepare(source)
    except SourceError as err:
        return _source_error(err)
    except ValueError as err:
        return _error(422, "unsupported_source", str(err))
    return 201, {"preview": _public(meta), "prepared": True}


def preview(handle):
    """GET /krc/ext/v1/resizer/previews/{handle}: a prepared preview, if still current."""
    provider = _provider("resizer.previews")
    meta, error = _fresh(provider, handle)
    return error or (200, {"preview": _public(meta)})


def frame(handle, index):
    """GET /krc/ext/v1/resizer/previews/{handle}/frames/{index}: one frame as JPEG."""
    provider = _provider("resizer.previews")
    try:
        number = int(str(index))
    except ValueError:
        return _error(400, "bad_request", "The frame index must be a whole number")
    meta, error = _fresh(provider, handle)
    if error:
        return error
    if not 0 <= number < int(meta["frameCount"]):
        return _error(404, "not_found", f"Frames are 0 to {int(meta['frameCount']) - 1}")
    data = provider.frame(meta["handle"], number)
    if data is None:
        return _error(404, "not_found", "That frame isn't there any more: prepare the preview again.")
    return 200, data


def _identity(payload, required):
    """The source identity a settings call is about: a live preview's (``handle``) or one
    given as ``source`` {width, height, frameCount, mediaSig}. -> (identity | None, error)."""
    handle, given = payload.get("handle"), payload.get("source")
    if handle is not None:
        provider = _provider("resizer.previews")
        meta, error = _fresh(provider, handle)
        if error:
            return None, error
        return {key: meta[key] for key in ("width", "height", "frameCount", "mediaSig")}, None
    if given is not None:
        if not isinstance(given, dict) or set(given) != {"width", "height", "frameCount", "mediaSig"} or not all(
                isinstance(given[key], int) and not isinstance(given[key], bool) and given[key] >= 0 for key in given):
            return None, _error(400, "bad_request", "source must be {width, height, frameCount, mediaSig} (whole numbers)")
        return dict(given), None
    if required:
        return None, _error(400, "bad_request", "Send a preview handle, or the source {width, height, frameCount, mediaSig}")
    return None, None


def _checked_body(payload, allowed):
    import json

    if not isinstance(payload, dict):
        return _error(400, "bad_request", "The body must be a JSON object")
    unknown = sorted(set(payload) - set(allowed))
    if unknown:
        return _error(400, "bad_request", f"Unknown key {unknown[0]!r} (one of {', '.join(allowed)})")
    if len(json.dumps(payload)) > MAX_SETTINGS_BYTES:
        return _error(413, "too_large", "That body is too large")
    return None


def inputs(payload):
    """POST /krc/ext/v1/resizer/inputs {handle | source, settings}: structured settings ->
    the node's inputs, stamped with this source's identity."""
    provider = _provider("resizer.settings")
    error = _checked_body(payload, ("handle", "source", "settings"))
    if error:
        return error
    identity, error = _identity(payload, True)
    if error:
        return error
    try:
        result = provider.build_inputs(identity, payload.get("settings") or {})
    except ValueError as err:
        return _error(400, "bad_request", str(err))
    return 200, {**result, "source": identity}


def settings(payload):
    """POST /krc/ext/v1/resizer/settings {inputs, handle? | source?}: the node's inputs (from a
    workflow) -> structured settings, and whether they're stale for the source."""
    provider = _provider("resizer.settings")
    error = _checked_body(payload, ("handle", "source", "inputs"))
    if error:
        return error
    raw = payload.get("inputs")
    names = ("crop_state", "pad_color", "custom_pad_color", "frame_select", "passthrough")
    if not isinstance(raw, dict) or set(raw) - set(names) or not all(isinstance(value, str) for value in raw.values()):
        return _error(400, "bad_request", f"inputs must be {{{', '.join(names)}}} (strings, as in the workflow)")
    identity, error = _identity(payload, False)
    if error:
        return error
    try:
        return 200, provider.read_settings(raw, identity)
    except ValueError as err:
        return _error(400, "bad_request", str(err))
