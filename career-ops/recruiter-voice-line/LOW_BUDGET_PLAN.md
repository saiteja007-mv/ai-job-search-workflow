# Low-Budget Recruiter Call Workflow

Goal: reduce recruiter-call burden without spending heavily on live AI voice minutes.

## Recommendation

Start with a $0–$5/month workflow first, then upgrade to live AI answering only if call volume proves it is worth it.

## Phase 1: Cheap voicemail triage

Use Google Voice or the existing AT&T voicemail path as the first filter.

Voicemail greeting:

> Hi, this is <YOUR_NAME>. If you're calling about an AI, ML, GenAI, LLM, NLP, MLOps, or Data Scientist role, please leave your name, company, client company, role title, location, salary or rate range, work authorization requirements, and email the JD to <YOUR_EMAIL>. I review relevant roles and follow up quickly.

Workflow:

1. Recruiter leaves voicemail.
2. Google Voice / phone voicemail produces a transcript when available.
3. Hermes/career-ops parses voicemail or email into a recruiter-call report.
4. Only strong leads get a callback or drafted email.

Estimated cost: $0/month if using Google Voice personal or existing mobile voicemail.

Tradeoff: caller does not have a live conversation with AI. But it filters 80% of low-quality recruiter noise cheaply.

## Phase 2: Twilio low-cost intake line, no live AI

Use a Twilio local number for a controlled job-search phone line. Forward missed calls or publish this number in job-search material.

Costs from public Twilio US Voice pricing:

- Local number: about $1.15/month
- Incoming local calls: about $0.0085/min

For 50 calls x 4 minutes: about $2.85/month before transcription/LLM add-ons.

Tradeoff: requires small script/webhook setup and does not answer with live intelligence unless combined with Vapi or a custom voice stack.

## Phase 3: Vapi only for filtered calls

Use Vapi only after the cheap filter proves volume/quality.

Cost controls:

- Do not forward every call by default.
- Use it only for dedicated recruiter number or missed calls.
- Max call duration: 3 minutes.
- First prompt collects facts quickly and asks for JD by email.
- Disable transfers unless strong lead.
- Use cheap model/voice/STT settings.
- Review usage weekly.

Vapi rough low-volume examples:

- 30 calls x 3 min = 90 min: platform $4.50, rough incl. model ~$6.30
- 50 calls x 4 min = 200 min: platform $10, rough incl. model ~$14
- 100 calls x 4 min = 400 min: platform $20, rough incl. model ~$28

Note: provider/model pass-through can vary, so use billing caps.

## Recommendation for <YOUR_NAME>

Start Phase 1 immediately: voicemail/email triage. It is almost free and good enough to separate real recruiters from spam/AI calls.

Upgrade to Phase 3 only when there are enough real inbound calls that live AI answering is worth the spend.
