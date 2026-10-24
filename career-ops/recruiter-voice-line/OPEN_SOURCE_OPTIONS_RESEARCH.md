# Open-source recruiter voice agent + calling options

Updated: 2026-08-10

## Short answer

For the cheapest useful path, do **not** start with Vapi/<TARGET_COMPANY>/Bland. Use an open-source voice-agent framework plus a low-cost SIP/phone carrier.

Best practical pick for <YOUR_NAME>:

> **Pipecat + Telnyx/Twilio Media Streams + local or cheap cloud STT/TTS/LLM**

Why: Pipecat is open source, current, Python-based, explicitly supports telephony via Twilio/Telnyx/Plivo/Exotel WebSockets and Daily/SIP, and is easier to wire into the existing Hermes/career-ops stack than PBX-only systems.

If we want more WebRTC/SIP infra and warm transfer later:

> **LiveKit Agents + LiveKit SIP + Telnyx/Twilio SIP trunk**

Why: strong open-source agent framework, built-in telephony docs, SIP server, transfers, and production readiness. More infrastructure complexity than Pipecat.

If we want old-school phone PBX control:

> **Asterisk/FreePBX + AudioSocket/ARI + local AI pipeline**

Why: cheapest carrier path and maximum PBX control, but more ops/debugging burden.

## Researched options

### 1. Pipecat

- Repo: https://github.com/pipecat-ai/pipecat
- Stars checked: ~14,043
- License: BSD-2-Clause
- Description: open-source framework for voice agents, multimodal apps, and realtime AI.
- Telephony support from docs:
  - PSTN/SIP dial-in and dial-out.
  - WebSocket connections: Twilio, Telnyx, Plivo, Exotel.
  - Daily PSTN/SIP support.
  - Twilio Media Streams examples for inbound and outbound.
- Strengths:
  - Python, easy to integrate with career-ops and Hermes.
  - Bring your own STT/TTS/LLM providers.
  - Can start with hosted STT/TTS, then move local later.
  - Explicit telephony docs.
- Weaknesses:
  - Still needs a phone carrier and a running server/webhook.
  - Fully local low-latency STT/TTS may take tuning.
- Fit for <YOUR_NAME>: **Best overall low-cost open-source option.**

### 2. LiveKit Agents + LiveKit SIP

- Repo: https://github.com/livekit/agents
- Stars checked: ~12,892
- License: Apache-2.0
- Description: framework for realtime voice AI agents.
- Telephony support from docs:
  - LiveKit Telephony connects traditional phone networks.
  - Supports phone numbers, SIP trunk setup, Twilio/Telnyx/Plivo/Wavix/Sinch/didlogic provider guides.
  - Inbound calls, outbound calls, DTMF, answering-machine detection, cold/warm transfers.
  - Self-hosted SIP server available, but ports 5060 and 10000-20000 must be reachable from internet.
- Strengths:
  - More complete realtime/telephony platform.
  - Good if we later need transfer to <YOUR_NAME>’s phone, SIP control, or browser/mobile voice UI.
  - Open-source agent framework.
- Weaknesses:
  - More infrastructure than Pipecat.
  - Self-hosted SIP requires public network/firewall handling.
- Fit for <YOUR_NAME>: **Best production architecture if we want deeper telephony features later.**

### 3. Vocode

- Repo: https://github.com/vocodedev/vocode-core
- Stars checked: ~3,783
- License: MIT
- Description: modular open-source voice-based LLM agents.
- Strengths:
  - Simple conceptual model for STT/LLM/TTS voice agents.
  - Existing Twilio-oriented examples historically.
- Weaknesses:
  - Smaller/more uncertain ecosystem than Pipecat/LiveKit right now.
  - I would not choose it as the primary path unless examples fit perfectly.
- Fit for <YOUR_NAME>: **Backup option, not first pick.**

### 4. Fonoster

- Repo: https://github.com/fonoster/fonoster
- Stars checked: ~8,075
- License: MIT
- Description: open-source alternative to Twilio.
- Strengths:
  - Open-source telephony stack, closer to replacing Twilio than replacing Vapi.
  - Useful if we want to self-host phone infrastructure.
- Weaknesses:
  - It is more of a communications/telephony platform, not a complete AI recruiter agent by itself.
  - Still needs SIP trunk/carrier and AI stack.
- Fit for <YOUR_NAME>: **Interesting long-term Twilio replacement, not MVP.**

### 5. Asterisk / FreePBX

- Asterisk repo: https://github.com/asterisk/asterisk
- Stars checked: ~3,441
- License: other/GPL-style project licensing.
- FreeSWITCH repo: https://github.com/signalwire/freeswitch
- Stars checked: ~5,075
- Description: mature software telecom stack.
- Strengths:
  - Battle-tested PBX/SIP.
  - Very cheap with SIP carriers like Telnyx/VoIP.ms.
  - Can do voicemail, IVR, call recording, forwarding, caller ID rules.
- Weaknesses:
  - AI integration is more custom: ARI/AudioSocket/media bridge to STT/LLM/TTS.
  - More debugging and ops; not ideal as first prototype.
- Fit for <YOUR_NAME>: **Best if we only need voicemail/IVR and ultra-low cost; harder for live AI.**

## Calling/carrier options

### Telnyx Elastic SIP

- Pricing page checked: https://telnyx.com/pricing/elastic-sip
- Public page showed:
  - Local inbound calls starting at **$0.0032/min**.
  - Numbers starting around **$1/month**.
  - Call recording **$0.002/min**.
- Fit: cheapest clean SIP/WebSocket carrier option found in this pass.

### Twilio Voice / Media Streams

- Pricing page checked: https://www.twilio.com/en-us/voice/pricing/us
- Prior estimate used:
  - US local inbound roughly **$0.0085/min**.
  - Local number roughly **$1.15/month**.
- Fit: more expensive than Telnyx, but documentation/examples are abundant. Strongest compatibility with Pipecat examples.

### VoIP.ms

- Public pricing page was blocked by fetch, but typical DID/SIP pricing is low.
- Fit: good cheap SIP trunk for Asterisk/FreePBX. Less convenient for modern WebSocket voice-agent pipelines than Twilio/Telnyx.

### Google Voice

- Personal Google Voice is cheap/free but not a reliable programmable phone-agent platform.
- Fit: keep as public/job-search number or voicemail path; do not use as core live AI backend.

### AT&T mobile number

- Best use: keep it as real personal phone, use conditional call forwarding for missed/busy/unanswered recruiter calls to the AI/voicemail number.

## Estimated monthly phone-carrier cost only

Assumptions:

- Telnyx: $1/month number + $0.0032/min inbound.
- Twilio: $1.15/month number + $0.0085/min inbound.
- VoIP.ms rough: $0.85/month DID + $0.009/min inbound.
- AI compute cost excluded if local. If using cloud STT/TTS/LLM, add that separately.

| Usage | Telnyx SIP | Twilio Voice | VoIP.ms rough |
|---|---:|---:|---:|
| 30 calls × 3 min | $1.29/mo | $1.92/mo | $1.66/mo |
| 50 calls × 4 min | $1.64/mo | $2.85/mo | $2.65/mo |
| 100 calls × 4 min | $2.28/mo | $4.55/mo | $4.45/mo |
| 200 calls × 4 min | $3.56/mo | $7.95/mo | $8.05/mo |

## Open-source STT/TTS/LLM building blocks

### STT

- `whisper.cpp`: https://github.com/ggml-org/whisper.cpp — MIT, ~52,794 stars checked. Local Whisper in C/C++.
- `faster-whisper`: https://github.com/SYSTRAN/faster-whisper — MIT, ~24,844 stars checked. Faster Whisper transcription with CTranslate2.

For live calls, streaming STT latency matters. Cloud STT like <TARGET_COMPANY> is easier at first; local Whisper can be used later if latency is acceptable.

### TTS

- `Piper`: https://github.com/rhasspy/piper — MIT, ~11,277 stars checked. Fast local neural TTS.
- `Kokoro`: https://github.com/hexgrad/kokoro — open model repo checked. Good lightweight TTS candidate, but telephony integration needs testing.

For natural recruiter calls, local TTS may sound less polished than ElevenLabs/Cartesia/OpenAI. But for low budget, Piper/Kokoro can work if we accept less human-like voice.

### LLM

- Local Hermes/LFM or llama.cpp model can answer bounded recruiter questions using career-ops context.
- For reliability, use a tight prompt and structured call state, not open-ended chatting.

## Recommended low-cost architecture

### MVP A: cheapest useful system — voicemail/intake first

```txt
Google Voice / AT&T voicemail
        ↓
voicemail transcript or email JD
        ↓
Hermes career-ops parser
        ↓
Slack summary + recommended action
```

Cost: $0/month.

Best if money is the main concern and live conversation is optional.

### MVP B: open-source live agent — my recommended next step

```txt
Recruiter calls dedicated Telnyx or Twilio number
        ↓
Telnyx/Twilio WebSocket media stream
        ↓
Pipecat bot on home server/VPS
        ↓
STT: <TARGET_COMPANY> first or local Whisper later
LLM: local Hermes/llama.cpp with career-ops context
TTS: Piper/Kokoro local or cheap hosted TTS
        ↓
call summary saved to career-ops + Slack
```

Estimated carrier-only cost: about **$1–$5/month** for your likely call volume.

### MVP C: production open-source platform

```txt
AT&T conditional forwarding / job-search number
        ↓
Telnyx/Twilio SIP trunk
        ↓
LiveKit SIP server + LiveKit Agents
        ↓
local/cloud STT + LLM + TTS
        ↓
warm transfer to <YOUR_NAME> if lead is strong
```

Better later, but more setup.

## My revised pick

For you, I would choose:

> **Pipecat + Telnyx if we prioritize cheapest monthly cost.**

or

> **Pipecat + Twilio if we prioritize easiest examples and fastest setup.**

I would avoid Vapi/<TARGET_COMPANY>/Bland for now because their per-minute AI platform costs are unnecessary until call volume or urgency proves we need managed voice-agent hosting.

## Activation checklist

1. Decide carrier:
   - Cheapest: Telnyx.
   - Easiest docs/examples: Twilio.
2. Buy a dedicated job-search number.
3. Run Pipecat bot locally first with ngrok/Tailscale Funnel/public HTTPS endpoint.
4. Use career-ops prompt/context from:
   - `career_ops_voice_context.md`
   - `vapi_assistant_prompt.md` adapted into Pipecat system prompt.
5. Test with 10 simulated recruiter calls.
6. Only after tests: set AT&T conditional forwarding for missed/busy/unanswered calls.

## Important compliance note

The agent should disclose it is an AI voice line. It can speak naturally and answer factual questions in first person after disclosure, but it should not falsely pretend to be human <YOUR_NAME>.
