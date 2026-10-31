"""Selected-ID Fetch/Stabilize jobs. No model filesystem move/rename/delete API."""
import asyncio
import uuid

from ..bulk_selection import validate_card_ids
from ..server_sync import publish_sync, SYNC_EVENTS
from ..lora_loadout import civitai_batch_job as fetch_jobs
from ..lora_loadout.civitai_batch import plan_targets, cached_not_found_ids, record_size
from ..lora_loadout.library_index import LoraLibraryIndex
from ..lora_loadout.identity import IdentityStore as LoraIdentityStore
from .identity import IdentityStore, is_local_library_id
from .library_index import ModelLibraryIndex
from .stabilize import stabilize_model_by_id

_jobs = {}
_tasks = set()


async def selection_plan(payload):
    if not isinstance(payload, dict) or payload.get("operation") not in ("fetch", "stabilize"):
        raise ValueError("Unsupported model selection operation.")
    ids = validate_card_ids(payload.get("ids"))
    loras, models = await LoraLibraryIndex.loaded(), await ModelLibraryIndex.loaded()
    records = []
    seen = set()
    lora_identities, model_identities = LoraIdentityStore(), IdentityStore()
    for item_id in ids:
        lora = loras.get(item_id)
        model = models.get(item_id) if not lora else None
        if not (lora or model):
            lora = loras.get(lora_identities.canonical_id(item_id))
            model = models.get(model_identities.canonical_id(item_id)) if not lora else None
        record = lora or model
        if not record:
            raise ValueError("A selected model no longer exists. Refresh and select again.")
        key = record["library_id"]
        if key not in seen:
            seen.add(key); records.append((bool(lora), record))
    if payload["operation"] == "fetch":
        # The same eligibility predicate and cached-not-found policy as the Fetch page.
        candidates = [record for lora, record in records if lora]
        def plan_fetch():
            stable = [record["library_id"] for record in candidates if not is_local_library_id(record["library_id"])]
            return plan_targets(candidates, not_found_ids=cached_not_found_ids(stable), size_of=record_size)["targets"]
        targets = await asyncio.to_thread(plan_fetch)
    else:
        targets = [record for _lora, record in records if is_local_library_id(record["library_id"])]
    return ids, targets


async def preview(payload):
    ids, targets = await selection_plan(payload)
    return {"ok": True, "count": len(ids), "eligible": len(targets), "skipped": len(ids) - len(targets),
            "message": (f"{len(targets)} of {len(ids)} selected cards are eligible. "
                        + ("Fetch applies only to LoRAs and fills missing metadata using Civitai; general models are skipped. " if payload["operation"] == "fetch" else "Stabilize computes content hashes and updates library identity. Already-stable cards are skipped. ")
                        + "Large model files can take a long time to read. Cancel stops remaining work after the current item finishes. Model files are never moved, renamed or deleted.")}


def snapshot(job):
    if job["kind"] == "fetch":
        run = job["run"]
        outcomes = run.outcomes
        processed = {entry["id"] for entry in outcomes}
        retry = [entry["finalId"] for entry in outcomes if entry["status"] == "failed"]
        aliases = {identity["oldId"]: identity["newId"] for identity in run.identities}
        retry.extend(aliases.get(item_id, item_id) for item_id in job["targets"] if item_id not in processed)
        counts = run.counts
        return {"id": job["id"], "kind": "fetch", "state": run.state, "active": run.active,
                "total": job["total"], "done": job["skipped"] + run.done,
                "succeeded": counts["fetched"] + counts["thumbPending"],
                "skipped": job["skipped"] + counts["skipped"], "notFound": counts["notFound"],
                "failed": counts["failed"], "current": run.current, "note": run.note,
                "identities": run.identities, "issues": list(run.errors) + list(run.warnings),
                "retryIds": list(dict.fromkeys(retry))}
    return {key: value for key, value in job.items() if key not in ("targets", "names")}


async def run_stabilize(job, *, stabilize=stabilize_model_by_id, announce=publish_sync):
    try:
        for item_id in job["targets"]:
            await asyncio.sleep(0)
            if job["state"] == "cancelling":
                break
            job["current"] = {"id": item_id, "name": job.get("names", {}).get(item_id, item_id), "phase": "Hashing"}
            try:
                body, status = await stabilize(item_id)
                if status != 200 or not body.get("ok"):
                    raise ValueError(body.get("error") or "Could not stabilize model.")
                identity = body.get("identity")
                if identity:
                    job["identities"].append(identity)
                    announce(SYNC_EVENTS["IDENTITY_CHANGED"], {"identity": identity})
                    job["succeeded"] += 1
                else:
                    job["skipped"] += 1
            except Exception as exc:  # each failed item is retryable; continue the snapshot
                job["failed"] += 1
                job["issues"].append({"id": item_id, "text": str(exc)})
            else:
                job["retryIds"].remove(item_id)
            job["done"] += 1
        job["state"] = "cancelled" if job["state"] == "cancelling" else "done"
    except Exception as exc:
        job["state"] = "failed"; job["note"] = f"Stopped by an internal error: {exc}"
    finally:
        job["active"] = False; job["current"] = None
        # One end-of-run inventory refresh also re-collapses duplicate content IDs.
        # Never force a filesystem scan for each selected file.
        ModelLibraryIndex._cache = {}; LoraLibraryIndex._cache = {}
        announce(SYNC_EVENTS["LIBRARY_CHANGED"], {})


async def start(payload):
    ids, targets = await selection_plan(payload)
    if payload.get("confirmed") is not True:
        raise ValueError("Confirm the long-running operation before starting.")
    if not targets:
        raise ValueError("No eligible selected cards remain.")
    kind = payload["operation"]
    if kind == "stabilize" and any(job["kind"] == kind and snapshot(job)["active"] for job in _jobs.values()):
        raise ValueError("A selected-model stabilization job is already running.")
    job_id = uuid.uuid4().hex
    if kind == "fetch":
        result, status = await fetch_jobs.start_job(selected_ids=[record["library_id"] for record in targets])
        if status != 200:
            raise ValueError(result.get("error") or "Could not start Fetch.")
        run = fetch_jobs.current_job()
        target_ids = [record["library_id"] for record in run.targets]
        job = {"id": job_id, "kind": kind, "run": run, "total": len(ids), "targets": target_ids,
               "skipped": len(ids) - len(target_ids)}
    else:
        target_ids = [record["library_id"] for record in targets]
        job = {"id": job_id, "kind": kind, "active": True, "state": "running", "total": len(ids),
               "targets": target_ids, "done": len(ids) - len(targets), "succeeded": 0,
               "names": {record["library_id"]: record.get("display_name") or record.get("filename") or record["library_id"] for record in targets},
               "skipped": len(ids) - len(targets), "notFound": 0, "failed": 0, "current": None,
               "identities": [], "issues": [], "retryIds": list(target_ids), "note": ""}
        task = asyncio.create_task(run_stabilize(job))
        _tasks.add(task); task.add_done_callback(_tasks.discard)
    _jobs[job_id] = job
    # Keep active runs and a bounded set of finished results for reconnecting clients.
    for old_id in list(_jobs):
        if len(_jobs) <= 32:
            break
        if not snapshot(_jobs[old_id])["active"]:
            del _jobs[old_id]
    return {"ok": True, "job": snapshot(job)}


def status(job_id):
    if job_id not in _jobs:
        raise ValueError("This job is unavailable (the server may have restarted). No new job was started.")
    return {"ok": True, "job": snapshot(_jobs[job_id])}


def cancel(job_id):
    status(job_id)
    job = _jobs[job_id]
    if snapshot(job)["active"]:
        if job["kind"] == "fetch":
            job["run"].request_cancel()
        else:
            job["state"] = "cancelling"
    return status(job_id)
