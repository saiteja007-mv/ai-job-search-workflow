/**
 * autoreply-guards.mjs — the safety rules a LinkedIn auto-reply must never cross, as pure
 * functions with zero I/O and zero imports.
 *
 * Why this exists: the guarded auto-reply pipeline (webhook filter -> classify -> draft ->
 * send) has several stages that each need the SAME answer to "is this text safe to say" and
 * "is this text safe to trust". Keeping that logic in one dependency-free module means every
 * stage — including tests, which run it thousands of times against fixtures with no network
 * or filesystem — gets identical, deterministic answers, and a category can't drift between
 * the drafter and the sender because they import the same regexes instead of two copies.
 *
 * scanText() is deliberately conservative: it is a guard against an outbound message being
 * sent that answers something it should never answer unattended (comp, scheduling, SSNs,
 * a prompt-injection attempt echoed back), not a spam filter with a precision target. When in
 * doubt it blocks.
 */

// --- constants ---------------------------------------------------------------

export const EXPECTED_LINKEDIN_ACCOUNT_ID = '<UNIPILE_LINKEDIN_ACCOUNT_ID>';
export const WHATSAPP_STATUS_CHAT_ID = '<ID>';
export const WHATSAPP_STATUS_CHAT_NAME = '<WORKSTATION> US';
export const MAX_OUTBOUND_CHARS = 600;
export const CHAT_CAP_WINDOW_MS = 86400000;
export const TRIGGER_MAX_AGE_MS = 7 * 86400000;
export const UNTRUSTED_TEXT_MAX = 2000;
export const AUTOREPLY_LOG_REL = 'data/linkedin-autoreply-log.jsonl';
export const OUTREACH_LOG_REL = 'data/outreach_log.json';
export const FOLLOWUPS_REL = 'data/linkedin-invite-followups.jsonl';

// --- lexicon -------------------------------------------------------------------
// One or more regexes per category. A category is "present" when ANY of its patterns match.
// Order here is the fixed output order for scanText()'s categories array.

const GREETING_RE_1 = /\b(nice|great|good|lovely|pleasure|pleased|happy|glad)\s+(to\s+)?(e-?)?meet(ing)?\s+you\b/gi;
const GREETING_RE_2 = /\bpleasure meeting you\b/gi;

const LEXICON = [
  {
    category: 'compensation',
    patterns: [/compensation|comp\b|salary|salaries|\bpay\b|paid|payrate|pay rate|\brate\b|hourly|per hour|\/hr|\/hour|wage|budget|\$\s?\d|\d+\s?k\b|\busd\b|equity|stock options|\brsu|bonus|benefits/i],
  },
  {
    category: 'offer_contract',
    patterns: [/offer letter|\boffers?\b|\boffered\b|contract(or|s|ing)?\b|w-?2\b|1099|agreement|term sheet|employment terms/i],
  },
  {
    category: 'interview',
    patterns: [/interview\w*|phone screen|screening (call|round)|\bscreen\b|technical round|on-?site interview|onsite|assessment|coding (test|challenge)|hackerrank|codility|take-?home/i],
  },
  {
    category: 'scheduling',
    patterns: [/schedul\w*|calendar|calendly|availability|available (on|at|for|this|next|tomorrow)|time slot|what time|time ?zone|meeting|meet (on|at|this|next|tomorrow|up)|(phone|video|quick|intro|zoom|teams|google meet) call|\bcall (me|you|on|at|this|next|tomorrow)|\bzoom\b|google meet|tomorrow|next week|this week|\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\d{1,2}(:\d{2})?\s?(am|pm)\b|\d{1,2}\/\d{1,2}(\/\d{2,4})?/i],
  },
  {
    category: 'resume_attachment',
    patterns: [/resume|résumé|\bcv\b|curriculum vitae|attach\w*|upload\w*|portfolio|cover letter|\.pdf|\.docx?|word (doc|document|format)|transcript|certificate/i],
  },
  {
    category: 'contact_details',
    patterns: [
      /[\w.+-]+@[\w-]+\.[\w.-]+/,
      /(\+?\d[\d\s().-]{7,}\d)/,
      /e-?mail|phone|mobile|cell|whatsapp|telegram|signal|text me|contact (details|info|information)|reach (me|you) (at|on)|(phone|contact|your|my) number/i,
    ],
  },
  {
    category: 'work_authorization',
    patterns: [/visa|\bopt\b|stem opt|\bstem\b|h-?1b|h1-?b|citizen\w*|green ?card|\bgc\b|work authori[sz]ation|authori[sz]ed to work|sponsor\w*|\bead\b|\bf-?1\b|\bcpt\b|tn visa|immigration|i-?9\b|permanent resident|eligible to work|legally (able|eligible)/i],
  },
  {
    category: 'relocation',
    patterns: [/relocat\w*|willing to move|move to|on-?site|hybrid|in[- ]person|commute|local (to|candidates?)|based in/i],
  },
  {
    category: 'availability',
    patterns: [/start date|available to start|when can you (start|join|begin)|notice period|joining date|earliest (start|date)|immediate joiner|how soon/i],
  },
  {
    category: 'legal_financial_personal',
    patterns: [/\bssn\b|social security|passport|date of birth|\bdob\b|bank (account|details)|account number|routing number|\btax(es)?\b|w-?4\b|background check|drug (test|screen)|\bnda\b|non-?disclosure|lawsuit|\blegal\b|attorney|lawyer|medical|disabilit\w*|religion|marital|pregnan\w*|criminal|credit (score|check)|home address|mailing address/i],
  },
  {
    category: 'links_uploads_applications',
    patterns: [/https?:\/\/|\bwww\.|\b[\w-]+\.(com|io|ai|co|net|org|ly|me|app|dev|link)\b|apply (here|now|via|through|at|using|on)|application (link|form|portal|page)|job (link|posting|req|id)|fill (out|in) (the |this |an? )?form|register (here|at|on)|sign ?up|referral link|click (here|the link|below)/i],
  },
  {
    category: 'commitment',
    patterns: [/are you (interested|open|available|willing|ok|okay|comfortable)|would you (be )?(interested|willing|able|open)|can you (confirm|commit|join|start|make it)|could you (confirm|commit|join|start)|confirm (that )?you|\b(please |kindly )?(confirm|acknowledge)\b|let me know if you('re| are| can| will| would)|do you (accept|agree|want)|yes or no|i('m| am) (available|free|in)\b|count me in|i accept|i (will|'ll|can|could|would) (send|share|attach|start|join|relocate|accept|commit|be available|make it|do that)/i],
  },
  {
    category: 'promotion_spam',
    patterns: [/promotion|\bpromos?\b|discount|% ?off|guaranteed|earn \$|make money|work from home|passive income|crypto|bitcoin|forex|investment opportunity|webinar|masterclass|bootcamp|\bcourses?\b|training program|certification program|enroll|subscribe|newsletter|sponsored|giveaway|free trial|exclusive (offer|deal)|dm me for|check out my/i],
  },
  {
    category: 'urgency_spam',
    patterns: [/limited[- ]time|act now|urgent\w*|immediately|\basap\b|right away|last chance|expires (today|soon)|only \d+ (spots|seats|left)/i],
  },
  {
    category: 'c2c_solicitation',
    patterns: [/\bc2c\b|corp[- ]to[- ]corp|w2\/c2c|bench (sales|candidates|list)|hot ?list|paid placement|placement fee|pay (to|for) (get )?(placed|placement)|training (and|\+|&) placement|guaranteed (placement|job|interview)|h1b transfer|visa transfer|marketing (your )?profile|submit (your )?profile to|\bvendor\b/i],
  },
  {
    category: 'resume_upload_request',
    patterns: [/(upload|submit|send|share|attach|forward|email)(\s+(me|over|us|along))?(\s+(your|an?|the|updated|latest))*\s+(resume|résumé|cv|profile|word\s+(doc|copy))|resume (upload|link|portal)|drop your (resume|cv)/i],
  },
  {
    category: 'embedded_instructions',
    patterns: [/ignore (all |any |the )?(previous|prior|above|earlier) (instructions|messages|prompts?)|disregard (the |all )?(previous|prior|above)|as an? (ai|assistant|bot|language model|llm)|you are (an? |the )?(ai|assistant|bot|language model|agent)|system prompt|^\s*(system|assistant|user|tool)\s*:|<\/?(system|tool|instruction|assistant)|\[(inst|system|assistant)\]|do not (tell|inform|notify|alert) (sai|the user|your (owner|operator))|reply (with|only with) (exactly|only|the following)|respond (only )?with (exactly|only|the following)|forward this (message )?to|run (the|this) (command|script|code)|execute (the|this)|print (your|the) (api key|token|secret|prompt)|api[_ ]?key|secret key|password/im],
  },
];

/**
 * scanText(text) -> { blocked, categories } — categories in LEXICON order.
 * A greeting allowlist is stripped first so ordinary connection-etiquette phrases
 * ("nice to meet you", "great to meet you") never trip commitment/scheduling patterns.
 */
export function scanText(text) {
  if (text == null) return { blocked: false, categories: [] };
  const s = String(text);
  if (!s) return { blocked: false, categories: [] };
  const stripped = s.replace(GREETING_RE_1, ' ').replace(GREETING_RE_2, ' ');
  const categories = [];
  for (const { category, patterns } of LEXICON) {
    if (patterns.some((re) => re.test(stripped))) categories.push(category);
  }
  return { blocked: categories.length > 0, categories };
}

// Anything below 0x20 except \n \r \t.
const CONTROL_CHARS_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F]/;
// Same range but WITHOUT \r — used by truncateUntrusted, which strips \r too (see below).
const CONTROL_CHARS_NO_CR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;
const HTML_TAG_RE = /<\/?[a-zA-Z][^>]*>/;

/**
 * validateOutboundText(text, { maxChars }) -> { ok, reasons }
 * The gate an outbound message must clear before send: non-empty, under the length cap, no
 * HTML, no control characters, and not tripping any scanText() category.
 */
export function validateOutboundText(text, { maxChars = MAX_OUTBOUND_CHARS } = {}) {
  const s = text == null ? '' : String(text);
  const reasons = [];
  if (!s.trim()) reasons.push('text_empty');
  if (s.length > maxChars) reasons.push('text_too_long');
  if (HTML_TAG_RE.test(s)) reasons.push('text_has_html');
  if (CONTROL_CHARS_RE.test(s)) reasons.push('text_has_control_chars');
  const { categories } = scanText(s);
  for (const c of categories) reasons.push(`text_blocked:${c}`);
  return { ok: reasons.length === 0, reasons };
}

export function normalizeText(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * truncateUntrusted(text, max) -> { text, truncated, length }
 * Strips control chars (this time including \r — untrusted third-party text is never
 * displayed raw) before measuring/truncating. `length` is the stripped length, so a caller
 * can tell "was this cut short" from the number that matters, not the pre-strip one.
 */
export function truncateUntrusted(text, max = UNTRUSTED_TEXT_MAX) {
  const raw = String(text ?? '');
  const stripped = raw.replace(CONTROL_CHARS_NO_CR_RE, '');
  const length = stripped.length;
  const truncated = length > max;
  return { text: truncated ? stripped.slice(0, max) : stripped, truncated, length };
}
