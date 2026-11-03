import { makeLibraryEditMethods } from "../shared/library_edit_methods.js";
import { deleteLoraJson, fetchLora, postLoraForm, postLoraJson } from "./api.js";

// Thumbnails, save, stale clean-up and stabilize: the shared copy over this node's routes.
export const transferMethods = makeLibraryEditMethods({ fetchLora, postLoraForm, postLoraJson, deleteLoraJson }, { autoStabilizeOnPersist: true });
