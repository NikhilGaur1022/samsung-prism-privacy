# Lead note — HF_TOKEN resolved (2026-08-21)

The user supplied the `HF_TOKEN` that `docs/HANDOFF_2026-08-17_phase3-dead-code.md` §7 named as
the one outstanding blocker on verifying the audio pipeline end to end.

**Verified live by the lead:**

```
curl -H "Authorization: Bearer $HF_TOKEN" https://huggingface.co/api/whoami-v2
  -> {"type":"user","name":"raisaaa",...,"auth":{"accessToken":{"displayName":"pyannote","role":"read"}}}

curl -H "Authorization: Bearer $HF_TOKEN" https://huggingface.co/api/models/pyannote/speaker-diarization-3.1
  -> HTTP 200, gated:"auto", private:false, disabled:false
curl -H "Authorization: Bearer $HF_TOKEN" https://huggingface.co/api/models/pyannote/segmentation-3.0
  -> HTTP 200
curl -H "Authorization: Bearer $HF_TOKEN" https://huggingface.co/api/models/speechbrain/spkrec-ecapa-voxceleb
  -> HTTP 200

# the real license test — an actual gated weight file, not just metadata:
curl -L -H "Authorization: Bearer $HF_TOKEN" \
  https://huggingface.co/pyannote/segmentation-3.0/resolve/main/pytorch_model.bin
  -> HTTP 200  size=5905440
```

Both gated licences (`speaker-diarization-3.1` AND `segmentation-3.0`, which 3.1 loads
internally) are accepted on this account, and weights actually download.

**Written to** `ai-core/audio-worker/.env` (line 13). That file is gitignored
(`.gitignore:27` = `.env*` with `!.env.example`), confirmed with `git check-ignore -v`
and by `git status --short` showing no new tracked change.

## What this means for the audit

- The audio-worker process currently **listening on 8003 was started BEFORE the token was
  written**, so it still holds the empty value in memory. Any auditor probing 8003 right now is
  correctly observing the *un-tokened* behaviour: `diarization.py` raises "HF_TOKEN is not set"
  before any network call. Report that as the observed state of the running process, but do NOT
  report "the token is unobtainable" or "the gated licence is not accepted" — both are now false.
- The worker needs a restart to pick the token up. The lead is doing that restart and a dedicated
  audio end-to-end verification **after** the audit phase, deliberately, so it does not change the
  system underneath running auditors.
- Treat "audio pipeline never exercised end to end" as an **open verification gap being closed by
  the lead**, not as an unfixable blocker. It should still appear in the plan as a required
  verification step with an owner.
- The token belongs to a personal HF account (`raisaolaprath@gmail.com`, no org, `canPay:false`).
  That is a **production finding in its own right**: a pipeline dependency gated behind one
  individual's personal read token is a bus-factor and an offboarding risk, and the token is now
  sitting in plaintext in a developer `.env`. Production needs this in a secret manager, on an org
  account, with the licence accepted by the org — flag it.
