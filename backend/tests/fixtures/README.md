# End-to-end fixtures

The e2e suite drives the real face pipeline, so it needs real photographs —
ArcFace detects nothing in a synthetic or drawn face, and a test built on
generated pixels would pass without exercising anything.

Real photographs of identifiable people are not committed to this repository.
The repo-wide `.gitignore` already excludes `*.jpg`, so the three files below stay
local. Build them with:

```
npm run fixtures:e2e          # backend/scripts/make-e2e-fixtures.js
```

The script derives them from `backend/storage/media` on this machine. Nothing is
downloaded and nothing leaves the host.

| File | Must contain |
|------|--------------|
| `solo-a.jpg` | exactly one detectable face — person A alone |
| `group.jpg` | exactly two detectable faces — person A and person B |
| `enroll-b.jpg` | exactly one detectable face — person B, cropped from `group.jpg` |

Person A's enrollment selfie is `solo-a.jpg` itself. Enrolling from the same frame
that appears in the session makes the match score deterministic, which is what the
lifecycle test needs; the recogniser's tolerance for pose is not what is under
test here.

Substituting your own images is fine as long as each file holds the face count in
the table above and A and B are genuinely different people. The suite re-detects
on startup and fails with a clear message if not.

Requires the face worker on `:8001` (`FACE_SERVICE_URL`).
