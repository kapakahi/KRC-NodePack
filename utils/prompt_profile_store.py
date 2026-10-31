"""Explicit prompt-profile storage adapter shared by routes and transfers."""
from . import prompt_profiles as profiles
from . import prompt_vault_store as storage


class ProfileStore:
    def __init__(self, store, profile_id):
        self.store = store
        self.profile_id = profiles.require_profile(profile_id)["id"]

    def __getattr__(self, name):
        return getattr(self.store, name)

    def load_prompts(self):
        return self.store.load_prompts() if self.profile_id == profiles.DEFAULT_PROFILE_ID else storage.load_prompts(self.profile_id)

    def save_prompts(self, data, source=""):
        if self.profile_id == profiles.DEFAULT_PROFILE_ID:
            return self.store.save_prompts(data, source=source) if source else self.store.save_prompts(data)
        return storage.save_prompts(data, source=source, profile_id=self.profile_id)

    def prompts_for_response(self, data, **kwargs):
        if self.profile_id != profiles.DEFAULT_PROFILE_ID:
            kwargs["profile_id"] = self.profile_id
        return self.store.prompts_for_response(data, **kwargs)

