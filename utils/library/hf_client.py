"""
KRC shared — HuggingFace metadata egress boundary.

The second (and only other) file in the pack that makes an outbound request, besides
civitai_client.py — same contract: guard-first, offline-safe, never raises. Shared by
both nodes. One public endpoint, no auth:

  GET https://huggingface.co/{repo}/resolve/{branch}/README.md   (the model card)

The /resolve/ path is HF's high-limit, infra-optimized "Resolver" bucket. The author
comes from the repo path itself, so no second API call. Default branch is usually
`main`; older repos use `master`, so a 404 on the first falls through to the second.
See HF_METADATA_DESIGN.md.
"""
import asyncio

try:
    import aiohttp
except ImportError:  # aiohttp ships with ComfyUI, but never assume
    aiohttp = None

from ..krc_network import network_enabled
from . import egress

HF_CARD_URL = "https://huggingface.co/{repo}/resolve/{branch}/README.md"
_DEFAULT_BRANCHES = ("main", "master")
_TIMEOUT_SECONDS = 10  # total, seconds
_CONNECT_TIMEOUT_SECONDS = 5  # fail fast when HF is unreachable


async def fetch_model_card(repo):
    """Fetch a HuggingFace repo's model card (README.md).

    Returns a small status dict (never raises), mirroring civitai_client:
      {"status": "disabled"}                            consent off — no request made
      {"status": "unavailable"}                          no aiohttp / no repo
      {"status": "not_found", "url": ...}                404 on every branch (no repo/card/private)
      {"status": "error", "detail": ..., "url": ...}     network/HTTP failure
      {"status": "hit", "card": "<markdown>", "url": ...} success
    """
    # Guard FIRST — the server-side backstop to the UI's consent gate. A disabled
    # switch returns before a socket is ever opened.
    if not network_enabled():
        return {"status": "disabled"}
    if not repo or aiohttp is None:
        return {"status": "unavailable"}

    timeout = aiohttp.ClientTimeout(total=_TIMEOUT_SECONDS, sock_connect=_CONNECT_TIMEOUT_SECONDS)
    url = ""
    try:
        async with aiohttp.ClientSession(timeout=timeout) as session:
            for branch in _DEFAULT_BRANCHES:
                url = HF_CARD_URL.format(repo=repo, branch=branch)
                async with await egress.get(session, url) as resp:
                    if resp.status == 404:
                        continue  # try the next default branch (main -> master)
                    if resp.status != 200:
                        return {"status": "error", "detail": f"HTTP {resp.status}", "url": url}
                    return {"status": "hit", "card": await resp.text(), "url": url}
        return {"status": "not_found", "url": url}
    except asyncio.TimeoutError:
        return {"status": "error", "detail": "timeout", "url": url}
    except aiohttp.ClientError as err:
        return {"status": "error", "detail": str(err), "url": url}
    except Exception as err:  # never let the boundary crash a request handler
        return {"status": "error", "detail": str(err), "url": url}
