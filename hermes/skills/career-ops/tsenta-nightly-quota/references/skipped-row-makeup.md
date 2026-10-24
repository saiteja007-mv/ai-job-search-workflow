# Skipped-row makeup (not another nightly 100)

Use when <YOUR_NAME> says “complete that N skipped” after a Tsenta nightly recap.

## Cannot finish in place

Typical skip mix: `JOB_EXPIRED`, `CAPTCHA_FAILED` / `CAPTCHA_REQUIRED`, `JOB_CLOSED`, `MANUAL_APPLY_REQUIRED`. Those are terminal. In-flight rows from the recap often land `SKIPPED` + captcha + refunded — still not completable.

`REVIEW_REJECTED` + `canReapply: true` is not a green light to re-apply (senior title, status bar, or form reject).

## Makeup run

- Target **N attempts**, not `min(100, ceil(remaining/days_left))`.
- New cutoff timestamp before the first apply. Dedup last night’s job ids **and** earlier makeup waves’ `attempted_job_ids`.
- `optimizationModeOverride: HONEST`, `jobIds` batches of 10–20.
- Approve only `PENDING_RESUME_REVIEW` with `createdAt >= cutoff`. Leave <COMPANY_B> / <COMPANY_AJ> Spanish / <COMPANY_AE>-Colombia parked **unless** he said “approve all those N” / “approve them” about the leftover `needs` list — then include that old queue.
- Submit-review from **answers**, not blob-grep. <COMPANY_I> required middle name empty → reject.
- Do **not** treat EEO “Hispanic / Latino / Spanish origin” as a Spanish-fluency question. Match fluency labels only (`spanish speaking`, `fluent in spanish`); skip labels with `hispanic` / `latino` / `spanish origin` / `ethnicity` / `race`.
- Do not outreach unless asked; LinkedIn cap may already be used from the nightly pass.

## “Yes go on” / until N completed

If the first wave report offered another batch aimed at N **completed** and <YOUR_NAME> says yes, switch from N-attempts to **live COMPLETED since the makeup cutoff**. Count `list-applications(filter=submitted)` with `createdAt >= run_started_at_utc`, not script logs and not <YOUR_CITY>-today (a morning makeup and last night’s 10pm run can share a calendar day).

Long continuation scripts die on Tsenta MCP blips. Retry each MCP call 3–4 times with backoff. After a crash: stop the dead process, recount submitted since cutoff, recover **this cutoff’s** open reviews, then apply a small remaining gap — do not re-apply already-attempted ids.

## Defense / <VISA_EXTENSION> rejects (title + company, not JD rescue)

Hard-skip companies even when the title is AI/ML: <COMPANY_F>, <COMPANY_V>, <COMPANY_K> Nevada, <PAST_EMPLOYER_2> Federal, <COMPANY_T>, <COMPANY_U>, <COMPANY_J>, Booz, <COMPANY_H>, CACI, SAIC, SpaceX, Credence, RTX, IDT, “Nuclear Company”. A shortened BAD_COMPANIES regex that drops <COMPANY_F>/<COMPANY_V> will apply them.

Reject on the form, not after submit:
- <COMPANY_Y> (<VISA_CLASS> / “authorized to work permanently”).
- <COMPANY_X>: copy says they **do not participate in the <VISA_CLASS> <VISA_EXTENSION> extension program**. After “will you need work-authorization assistance = Yes” a required attestation field appears empty — reject; do not attest past ineligibility.

`submit-application-review` `{success: true, status: RUNNING}` is **not** completed. Re-get the review: if `awaitingReview` is still true or a required field is still null, the row is parked. Re-poll `get-application-status` until COMPLETED / SKIPPED / FAILED.

## Yesterday completed count

Live `list-applications(filter=submitted)`, <YOUR_CITY> `createdAt`. Stale `data/tsenta-apps.json` undercounts a 10pm CT run.
