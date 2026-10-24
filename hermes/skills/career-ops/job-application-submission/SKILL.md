---
name: job-application-submission
description: Use when filling or submitting job applications.
---

# Job Application Submission (career-ops)

Working dir: `/home/<YOU>/career-ops`. Covers ATS forms (Ashby, Greenhouse), YC Work at a Startup (WaaS), and talent-marketplace profiles (Fonzi-style). Evaluation/scoring and resume tailoring use the repo's own modes; this skill is the fill → approve → submit part.

## Standing rules (always)
- Fill and show before submitting. Default gate: post every question and its exact answer in Slack and submit only after approval. If the user says "fill the answers yourself", you can answer the open questions, but every free-text answer still has to be backed by `cv.md`, `cv-aiml.md` or `config/profile.yml`. Tell them what you wrote and flag stretch answers they should be ready to discuss.
- Work-auth wording: <VISA_STATUS>, EAD <EAD_DATES>. Authorized to work now = <YES_NO>. Future sponsorship = <YES_NO>. <VISA_EXTENSION_NOTE> Salary floor is <SALARY_FLOOR> (profile.yml). Decline all EEO questions. Location is <YOUR_CITY>, remote-first, willing to relocate to SF/NYC.
- Never type a password, including one the user pastes in chat. Tell the user to rotate a password they pasted and to save it with `hermes vault add`, then use the vault tools. If a form requires creating an account or logging in, mark it BLOCKED_LOGIN.
- After a confirmed submit, run `node set-status.mjs --row N Applied --note "..."`. Check replies/confirmations in the matching inbox.
- Final report: count of submitted vs not submitted, with the reason for each.

## Procedure
1. **Pick jobs from the tracker** (`data/applications.md`): status Evaluated, score ≥4.0, PDF ✅. Tell the user how many lower-score rows were left out.
2. **Phase 1, fill without submitting.** Delegate to Codex when the user asks for GPT-6 Sol: `codex exec -m gpt-6-sol -C /home/<YOU>/career-ops --dangerously-bypass-approvals-and-sandbox "$(cat prompt.md)"` run in the background with notify. The prompt must include: the hard no-submit rule, the facts above, the modes/apply.md preflight (liveness, role match, duplicate/blacklist check), one tab per job left open, and output `tmp/<batch>/REVIEW.md` plus one JSON per job with statuses READY_TO_SUBMIT / NEEDS_USER / BLOCKED_LOGIN / CLOSED / ERROR.
3. **Verify** REVIEW.md yourself. Cross-check free-text answers against the CV (grep). Post each job to Slack with its questions, answers, knock-out warnings and blanks.
4. **Phase 2, submit.** When there are several jobs, give phase 2 to a GPT-6 Sol Codex run too, rather than hand-driving form fixes in this session. Fighting one stubborn Ashby field by hand can use up the whole tool budget. The phase-2 prompt must list:
   - the approved job rows and their exact answers
   - "submit each at most once"
   - an inbox dedupe check before any resubmit
   - connect to the headed Chrome on :9444, not headless :9333
   - the Ashby quirks below
   - set-status only after a confirmed submit
   - output `tmp/<batch>/PHASE2.md` ending with `SUBMITTED_TODAY_TOTAL=N`

   Confirm success from the page text before counting it: Ashby shows "Success … application has been received", and Greenhouse redirects to `/jobs/<id>/confirmation`. Then verify the count against the tracker rows yourself.

## Pitfalls
- **Submit Ashby from a headed browser.** Ashby flags submits from the headless automation Chrome (:9333) as "possible spam", and retrying doesn't help. Launch a visible Chrome with its own profile: `DISPLAY=:0 google-chrome --remote-debugging-port=9444 --user-data-dir=~/.hermes/cache/apply-chrome-profile` (terminal background=true). Refill the form there with Playwright `connectOverCDP`, typing with `pressSequentially`.
- **Ashby field types differ.** Find each field by its `[data-field-path]` container.
  - Yes/No questions are `button[data-option=yes|no]` with `aria-pressed`, backed by a hidden checkbox. `.check()` does nothing on them; click the button and confirm `aria-pressed=true`.
  - Radio groups are `fieldset.ashby-application-form-input-radio-group`. Click the option row's label, then confirm with `input:checked`.
  - Some questions' text matches more than one container. Scope by `data-field-path` or use `.first()`.
  - Snapshot every field's state before clicking Submit.
- **Ashby can wipe earlier toggles.** Re-uploading a resume or re-filling one field can reset toggles set before it. Set toggles and radios last, re-read the full state, then submit.
- **Check confirmation before resubmitting.** If a submit leaves the form blank with no Success or corrections message, check the confirmation email/inbox before resubmitting, so you don't apply twice.
- **Report fields that won't register instead of guessing.** Some Ashby multi-select checkbox groups can refuse programmatic ticks (a real mouse click toggles a different option). Say so and hand the user the open tab rather than inventing a workaround.
- **Greenhouse selects are react-select.** Codex often leaves them blank. Fill them by typing into the combobox and choosing the option.
- **Magic links are single-use.** Opening one from the agent browser uses it up for the user; say so if the user also needs it. To log in yourself, fetch the link through Unipile: `$UNIPILE_API_BASE/emails?account_id=…` (the base URL already ends in `/api/v1`; don't add it again). Check spam too (`role=spam`).
- **Accounts may sit under a different email.** Check both Unipile Gmail accounts (jobmail and personal) for old sender mail before creating an account. YC WaaS is registered under the personal Gmail.
- **Dedupe against the inbox by company, not just the recent-N list.** The tracker can say Evaluated for a role that was already applied to months ago; the ATS then rejects it as a duplicate. Search Unipile mail for the company name or sender before phase 2. When the tracker's status is wrong, set it to Applied with the original date (`--on`).
- **Re-check liveness right before submitting.** Postings close between phase 1 and phase 2; a Workday posting can go from live to "page doesn't exist" within hours.
- **Check the live posting before submitting.** Re-open the live requisition; a job ID can change to a different role. If it changed, mark ERROR and don't submit a resume tailored to the old role.

## Login-gated sites (vault)
- **Vault origins are per site.** `hermes vault add` rejects a generic origin like "any". Give the user the exact scheme+host for each site, for example `https://<tenant>.wd1.myworkdayjobs.com` or `https://<co>.taleo.net`, with the jobmail email as the identifier. Tell them to use a fresh password, not one pasted in chat.
- **Account creation often goes through email verification first.** Taleo's "New User" form only takes a username and email, then emails an access code. The password is set on an access-code confirmation page. You can't type that code, so the user completes that step on their phone and sets the SAME password they saved in the vault. After that, the ordinary login page (one password box) can be filled with `browser_vault_fill`. Use the email as the Taleo username so it matches the vault identifier.
- **Emailed one-time-code logins can't be done from Slack.** <COMPANY_Q>-style sites have no password or authenticator key to save, and `browser_vault_enter_code` needs an interactive UI. Tell the user to apply from their phone, or to ask again from the Desktop app.
- **Bitwarden `vault-login` helper is not a fill path.** `~/.local/bin/vault-login <search>` (bws, project `vault-logins`) is fine for listing which sites have saved logins, but `--get` prints the password in plaintext, which you'd then have to type. Don't use `--get`; the vault tools only see Bitwarden when the `bw` CLI is installed and logged in on this host.
- A spawned Codex agent is under the same no-password/no-code rule. Finish the vault login in the shared browser yourself before handing the form to the agent.

## After applying: outreach
For LinkedIn invites + recruiter emails to people at the companies just applied to (drafting via GPT-6 Sol, superagnt-rule alignment, attaching tailored resumes to Gmail drafts, sending invites through the linkedin MCP), and for invite-cap changes, warm-outbound failures and withdrawing stale invites, follow `references/post-apply-outreach.md`.

## Platform notes
- **YC Work at a Startup.** Log in through `account.ycombinator.com/magic`.
  - Applying means sending a note of at least 50 characters to the founder. There's no per-job file upload; the founder sees the profile resume.
  - Write the note in voice-dna style: no em dashes, one CV-backed hook, honest gaps, <VISA_TYPE> status.
  - WaaS counts only citizens and existing visa holders as "authorized", and "sponsorship" includes <VISA_TYPE>. For <VISA_TYPE>, answer authorized = No and sponsorship = Yes.
  - Resume import mis-parses titles and dates and replaces the education list. Re-check every field against cv.md.
- **Fonzi (talent.fonzi.ai).** Email magic link, then a required LinkedIn OAuth step that the user has to do on their phone.
  - After that, fill the form (location combobox, `<SALARY_FLOOR>`, sponsorship = may need).
  - In the profile wizard, fill phone and headline with `Input.insertText`; plain value setting fails validation.
  - Upload the resume with `DOM.setFileInputFiles`, and fill the four summary textareas from the CV.
- **General React forms.** `fill_input`/value setting often doesn't register. Focus the element, then use CDP `Input.insertText`, or Playwright `pressSequentially`.