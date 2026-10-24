# Recruiter Voice Line — Vapi + Twilio Setup

Purpose: screen inbound recruiter calls while <YOUR_NAME> is busy, answer bounded career questions from career-ops context, collect structured role details, and send a summary back to Slack/career-ops.

## Recommended architecture

```txt
AT&T missed/unanswered calls or dedicated recruiter number
        ↓
Twilio local US number
        ↓
Vapi inbound assistant
        ↓
Hermes/n8n webhook endpoint
        ↓
career-ops report + Slack summary
```

## Identity policy

Do not pretend to be a live human if directly asked. Use transparent but first-person-friendly wording:

> Hi, this is <YOUR_NAME>'s AI voice line. I can answer common recruiter questions, collect role details, and make sure <YOUR_NAME> gets the full summary. Are you calling about an AI or ML opportunity?

The assistant may answer career facts in first person:

- "I'm targeting AI/ML Engineer, Applied AI, GenAI, LLM/NLP, and MLOps roles."
- "I'm based in <YOUR_CITY> and open to US remote, hybrid, or onsite roles."
- "I'm authorized to work in the US on <YOUR_WORK_AUTH_STATUS>."

## Required accounts / keys

1. Vapi account and API key.
2. Twilio account SID + auth token.
3. One Twilio local US number.
4. A public webhook URL for Hermes/n8n. Options:
   - Tailscale Funnel/Serve public HTTPS endpoint
   - Cloudflare Tunnel
   - n8n webhook if already publicly reachable

Store secrets only in `<CAREER_OPS_DIR>/.env` or Hermes secrets, never in docs/chat.

Suggested `.env` keys:

```bash
VAPI_API_KEY=
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_RECRUITER_NUMBER=
RECRUITER_VOICE_WEBHOOK_SECRET=
```

## Vapi assistant setup

1. Create a Vapi assistant.
2. Use `vapi_assistant_prompt.md` as the system prompt.
3. Add `career_ops_voice_context.md` as knowledge/context.
4. Enable call recording/transcription only with disclosure at start of call.
5. Add tools/actions:
   - `endCall`
   - `transferCall` to <YOUR_NAME>'s mobile only for high-confidence recruiters or urgent live scheduling
   - `apiRequest`/webhook to submit structured call summary
6. Attach assistant to the Twilio imported number.

## Twilio setup

1. Buy a local US Twilio number.
2. Import/connect Twilio number in Vapi using Twilio Account SID + Auth Token.
3. Assign the Vapi assistant to inbound calls.
4. Test inbound call from a non-Twilio phone.

## AT&T usage

Use conditional forwarding from <YOUR_NAME>'s AT&T mobile to the Twilio/Vapi number for missed/unanswered/busy calls. Keep direct mobile ringing first so <YOUR_NAME> can still answer important calls.

## Output artifact

Every screened call should produce a markdown report under:

```txt
<CAREER_OPS_DIR>/reports/recruiter-calls/YYYY-MM-DD-HHMM-caller.md
```

Minimum report fields:

- Caller name
- Caller phone
- Recruiter agency/company
- Client company
- Role title
- Role type: full-time/contract/W2/C2C
- Location + remote/hybrid/onsite
- Salary/rate range
- Work authorization / sponsorship answer
- JD link or request for JD
- Recruiter email
- Urgency
- Fit score: strong / maybe / reject
- Recommended next action
- Transcript link/text

## Hard rejects / escalation

Hard reject or mark low priority:

- C2C-only
- non-US roles
- senior/staff/principal/director roles unless JD years are 3–5 and scope is IC
- US citizen / green card / U.S. Person / clearance / ITAR/export-controlled roles
- unpaid training, fake vendor marketing, bench sales, vague AI calls, suspicious callers refusing client/company/JD

Escalate to <YOUR_NAME>:

- AI/ML/GenAI/MLOps/NLP role in US with salary/rate and real client/company
- recruiter accepts OPT/STEM OPT or says work authorization is okay
- interview scheduling request
- known target company
- direct employer recruiter

## Test checklist

1. Call says disclosure line clearly.
2. Agent collects all required fields.
3. Agent does not claim US citizenship / green card.
4. Agent does not negotiate final comp.
5. Agent asks for JD by email if missing.
6. Agent ends spam calls politely.
7. Webhook summary is delivered to Slack/career-ops.
8. Transfer only happens under allowed rules.
