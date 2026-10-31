import { makeNodeApi } from "../shared/api.js";

const PREFIX = "/krc/lora-loadout";

export const {
  loraPath,
  loraApiUrl,
  fetchLora,
  postLoraJson,
  deleteLoraJson,
  postLoraForm,
  getSharedJson,
} = makeNodeApi(PREFIX);
