# PRISM Platform: Comprehensive End-to-End Test Flow

This guide walks you through a complete lifecycle test of the PRISM platform, covering the **Video Pipeline**, **Core Features**, and the **DSAR (Erasure) loop**. It is structured chronologically, requiring you to switch between the 5 distinct Admin roles and the User Portal.

> [!TIP]
> **Testing Setup**
> It is highly recommended to use **Google Chrome Profiles** or an **Incognito Window** for the User Portal, and standard windows for the Admin Portal to avoid cookie collisions between roles.

---

## Phase 1: Project Governance (Data Owner & DPO)

### 1. Draft the Project (Role: `dataOwner`)
1. Log in to the Admin Portal as a **Data Owner**.
2. Navigate to **Create Project**.
3. Fill out the project details (e.g., "Q3 Video Analytics"). 
4. Under **Data Requirements**, select **Video** and **Audio** as required modalities, and select a consent template.
5. Submit the project. *Note: You cannot collect data yet; its status is `DRAFT`.*

### 2. Approve the Project (Role: `dpo`)
1. Log out, and log back in as the **DPO / Legal Team**.
2. Navigate to **Project Approvals** (this page is exclusive to DPOs and Super Admins).
3. Review the data requirements.
4. Click **Approve**. The project status changes to `APPROVED`.

### 3. Assign the Agent (Role: `dataOwner`)
1. Log back in as the **Data Owner**.
2. Navigate to **My Projects** -> Select "Q3 Video Analytics".
3. Under the **Assignments** tab, assign a **Collection Agent** to this project.

---

## Phase 2: Enrollment & Capture (Collection Agent & User)

### 4. Create the Session (Role: `collectionAgent`)
1. Log in to the Admin Portal as a **Collection Agent**.
2. Navigate to **New Session**.
3. Select the "Q3 Video Analytics" project and create a new session. 
4. Copy the **User Invite Link** generated for this session.

### 5. Subject Consent & Enrollment (User Portal)
1. Open the **User Invite Link** in an Incognito window.
2. Sign up / Log in as a new user (the Data Principal).
3. **Consent Hub:** Read the consent template and toggle **Accept**.
4. **Biometric Enrollment:** 
   - Complete the **Face Enrollment** (take a selfie). This generates your 512-dim ArcFace embedding.
   - Complete the **Voice Enrollment** (record a short voice snippet). This generates your 192-dim ECAPA-TDNN embedding.

### 6. Video Upload (Role: `collectionAgent`)
1. Return to the Admin Portal (Collection Agent).
2. Go to **Sessions** -> Open the active session.
3. Under **Subject Verification**, verify that the user's enrollment is complete.
4. Go to the **Upload** tab and upload a test `.mp4` video (Keep it under 15 seconds for testing).

---

## Phase 3: The Video Pipeline (Automated & Data Owner)

### 7. Automated Worker Processing (Background)
*Behind the scenes, the `video-worker` and `image-pii-worker` are now running.*
* The `video-worker` extracts frames, runs InsightFace to detect faces, and groups them into "tracks" (spatial continuity).
* The `image-pii-worker` scans frames for text like ID cards.

### 8. Tagging and Redaction (Role: `dataOwner` or `collectionAgent`)
1. Log in as the **Data Owner** (or stay as the Collection Agent).
2. Navigate to **Processed Data** (or Sessions).
3. Open the **Session Video Panel**.
4. **Action:** You will see the video and a list of detected "tracks" (faces grouped over time).
5. Tag the track that matches the enrolled user to confirm identity.
6. Click **Redact / Process**. 
7. *Result:* The system will re-encode the video. **Any face track that was NOT tagged as a consented user will be heavily blurred.**

---

## Phase 4: The DSAR Lifecycle (User, Data Admin, DPO)

### 9. Request Erasure (User Portal)
1. Switch back to the User Portal (Incognito window).
2. Go to **My Data / Privacy Rights**.
3. Submit a **DSAR (Data Subject Access Request)** for **Erasure** (Right to be Forgotten).

### 10. Request Discovery (Role: `dataAdmin`)
1. Log in to the Admin Portal as a **Data Admin**.
2. Navigate to the **DSAR Requests (Queue)**.
3. Open the new Erasure request.
4. Run **Discovery**. 
   * *Result:* The backend scans the entire database (Qdrant + Postgres) for that specific user's embeddings and associated media. It will flag the Video uploaded in Step 6.

### 11. Approval & Execution (Role: `dpo` -> `dataAdmin`)
1. Log in as the **DPO** and go to **DSAR Requests**. Review the discovery findings and **Approve** the erasure.
2. Log back in as the **Data Admin**.
3. Go to **Purge / Export** and execute the Purge.
   * *Result (Crypto-Shredding):* The `worker-purge` destroys the user's Data Encryption Key (DEK). 

### 12. Verification of Downgrade & Shredding
1. **The Shared-Object Downgrade:** Because that video might contain other people, the platform does *not* delete the video. Instead, it triggers a **DELETE → REDACT downgrade**. 
   * *Verify:* As a Data Owner, check the Session Video Panel again. The user's tags are completely gone, and the video has been re-rendered to blur the user who just revoked consent.
2. **The Deletion Certificate:** Go to the User Portal. The user will see their request is "Completed" and they can download a cryptographically signed **Deletion Certificate**.

---

## Phase 5: Oversight & Auditing (DPO & Super Admin)

### 13. Image Provenance (Role: `dpo`)
1. Log in as the **DPO**.
2. Navigate to **Image Provenance**.
3. If an image or video was exported *before* the user deleted their data, the DPO can upload the file here. The system reads the steganographic export stamp and decrypts it to show *who* was in the file at the time of export.
4. If a user was erased, it will show a gap (indicating the data outlived the deletion).

### 14. Audit Logs (Role: `super_admin` or `dpo`)
1. Navigate to **Audit Logs**.
2. You will see an immutable ledger of every action taken in this test: the project creation, the session capture, the DSAR execution, and every time a Data Admin read the user's personal data (`AccessEvent`). 

> [!IMPORTANT]
> **Break-Glass Protocol:** If you log in as a **Super Admin** and attempt to read raw media directly, the system forces a Break-Glass workflow. You must provide a justification, and an alert is immediately fired to the DPO's inbox.
