# Diagram prompts

Every diagram in this folder was made with ChatGPT image generation (Codex CLI `image_gen`), using the prompts below. Shared style for all of them: clean modern flat infographic, white background, navy text, teal and soft blue shapes, one amber accent for human-approval points, large legible sans-serif labels, generous spacing, no people, no logos, no watermark, landscape 16:9.

## 01-overview

```
Infographic titled 'AI Job Search Pipeline'. Seven rounded cards left to right joined by arrows, each with a simple line icon and exactly this short label: 'Discover jobs', 'Score fit', 'Tailor resume', 'Apply', 'LinkedIn outreach', 'Reply & follow up', 'Track'. A thin band under the row reads 'Claude Code + Hermes agents'. Two small amber shield badges: above 'Apply' reading 'You OK edge cases', above 'Reply & follow up' reading 'You OK replies'. No other text.
```

## 02-architecture

```
Infographic titled 'Where everything runs'. Three large rounded panels side by side. Left panel 'Workstation (Windows)' listing: 'Claude Code', 'Skills: resume, answers, apply', 'career-ops repo'. Middle panel 'Home server (Linux)' listing: 'Hermes Agent', 'systemd timers', 'LinkedIn MCP', 'Telegram bot', 'Dashboard'. Right panel 'Cloud services' listing: 'Claude Max', 'Tsenta', 'Unipile to LinkedIn', 'Slack'. A dashed tunnel line between the left and middle panels labeled 'Tailscale'. Arrows from the middle panel to the right panel. No other text.
```

## 03-daily-timeline

```
Infographic titled 'A day on autopilot'. A horizontal 24-hour timeline from 00:00 to 24:00 with tick marks. Markers above the line with short labels: '03:30 Agent update', '06:00 Apply run', '09:37 Warm invites (Mon-Fri)', '11:00 Apply run + Recruiter scout', '18:00 Apply run', '22:00 Nightly apply'. Below the line a thin repeating dotted band across the whole day labeled 'LinkedIn inbox check every 5 min'. No other text.
```

## 04-apply-loop

```
Infographic titled 'One apply run'. A circular loop of five steps with arrows: 'Set day target', 'Pull fresh jobs', 'Filter out bad fits', 'Apply', 'Check status every 60s'. From 'Apply' a side branch to an amber badge 'Parked? You say yes'. From the loop an exit arrow to a box 'Stop: target hit, time up, or no credits'. From that box an arrow to a final box 'Invite people at companies with confirmed applications'. No other text.
```

## 05-reply-loop

```
Infographic titled 'LinkedIn reply loop'. Flowchart left to right: box 'New message or accepted invite' to diamond 'What kind?'. Three branches from the diamond: 'Thanks' to 'No reply needed'; 'Not now' to 'Short template'; 'Anything else' to 'AI drafts reply'. From 'AI drafts reply' to diamond 'Passes safety checks?'. Yes branch to 'Re-read thread, then send'. No branch to amber box 'You approve in Telegram'. A small note under the chart: 'Quiet chat: one nudge after 7-10 days'. No other text.
```

## 06-outreach-budget

```
Infographic titled 'LinkedIn invite budget'. Directly under the title, a large bold subtitle line that reads exactly '30 invites a day · 170 a week · shared by every job'. Below it a large horizontal stacked bar with four colored segments with short labels: 'Recruiter scout up to 10', 'Warm invites up to 8', 'Apply runs up to 35 per run', 'Referral follow-ups up to 10'. Under the bar two amber rule tags: 'One person, one first message' and 'Stop at first refusal'. No other text.
```

## 07-resume-and-answers

```
Infographic titled 'From job post to application'. Five rounded cards left to right with arrows: 'Full job description', 'Score 0 to 5', 'Apply only 4.0+', 'Tailored 1-page resume', 'Answers to form questions'. Below the row, a wide amber banner spanning the whole width with large bold text that reads exactly 'Facts only from your CV files. Nothing invented.' No other text.
```

## 09-notifications

```
Infographic titled 'Where you hear about it'. Left column of four small event cards: 'Apply run summary', 'Recruiter scout report', 'Reply needs your OK', 'Something failed'. Arrows from the cards to a central rounded hub labeled 'notify'. From the hub, arrows fan out to a right column of channel chips with simple generic icons (no brand logos): 'Slack', 'Telegram', 'Discord', 'Teams', 'Email', 'ntfy push', 'WhatsApp'. Under the right column a small amber tag reading 'Approvals need a two-way chat: Telegram or Slack'. No other text.
```

## 10-any-agent

```
Infographic titled 'Bring your own agent'. Three horizontal layers stacked top to bottom, each a wide rounded band. Top band 'Agent' containing chips: 'Claude Code', 'Codex', 'OpenCode', 'Gemini / Antigravity', 'Cursor', 'Hermes'. Middle band 'Shared pieces' containing chips: 'Skills (SKILL.md)', 'MCP servers', 'Plain-text prompts', 'career-ops files'. Bottom band 'Scheduler' containing chips: 'systemd', 'cron', 'macOS launchd', 'Windows Task Scheduler', 'Docker'. Small arrows connect the bands. No other text.
```

## 08-costs

```
Infographic titled 'What it costs per month'. A clean horizontal bar chart with four bars and value labels: 'Claude Max $100', 'Unipile $55', 'Tsenta about $26', 'ChatGPT $0'. A small total tag at the right reading 'About $181 a month'. A short row of small grey chips under the chart reading 'Free: OpenRouter, TinyFish, jobspy, Slack, Telegram, Tailscale'. No other text.
```
