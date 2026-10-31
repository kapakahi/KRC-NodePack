import { makeNodeApi } from "../shared/api.js";

const PREFIX = "/krc/model-library";

export const {
  loraPath,
  loraApiUrl,
  fetchLora,
  postLoraJson,
  deleteLoraJson,
  postLoraForm,
  getSharedJson,
} = makeNodeApi(PREFIX);

// Single source of truth for the Model Library thumbnail route. ML's info panel
// and Config Switcher's model cards both build this URL; keeping the route here
// means the `/thumbnail/<id>` shape (and PREFIX) lives in exactly one place.
export function libraryThumbnailUrl(id, { version, kind } = {}) {
  const params = [];
  if (version) params.push(`v=${version}`);
  if (kind) params.push(`kind=${encodeURIComponent(kind)}`);
  const suffix = params.length ? `?${params.join("&")}` : "";
  return loraApiUrl(`/thumbnail/${encodeURIComponent(id)}${suffix}`);
}

// Internal readers opt out of the legacy duplicate row alias, using one shared URL.
export function libraryListPath(force = false) {
  return `/library?rows=items${force ? "&refresh=1" : ""}`;
}
