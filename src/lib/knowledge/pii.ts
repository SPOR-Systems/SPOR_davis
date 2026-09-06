/**
 * ============================================================================
 *  PERSONAL DATA SCAN
 * ============================================================================
 *  Knowledge articles are readable by everyone in the organisation. A procedure
 *  belongs there. The same procedure with a real person's account number and
 *  date of birth in the worked example does not — and that is how it usually
 *  happens: someone uploads a training deck built from a live record.
 *
 *  WHAT THIS IS AND IS NOT
 *  -----------------------
 *  A heuristic that FLAGS FOR HUMAN REVIEW. It is not a compliance control, it
 *  blocks nothing, and it will both miss things and cry wolf. Its whole job is
 *  to make the accidental case visible before publication rather than after.
 *
 *  Deliberately biased toward false positives: a flag costs a glance, a miss
 *  costs a disclosure.
 *
 *  DOMAIN NEUTRALITY
 *  -----------------
 *  The patterns cover identifiers that are personal in any industry — dates of
 *  birth, government numbers, contact details, payment cards, named individuals
 *  next to a record. Sector-specific formats are folded into those categories
 *  rather than given their own vocabulary, so a clinic's medical record number
 *  and a bank's customer number both match "Record or account numbers" without
 *  the product assuming which one you are.
 * ============================================================================
 */

export interface SensitiveScanResult {
  atRisk: boolean;
  /** What matched, for the reviewer. Never the matched text itself. */
  findings: string[];
}

interface Pattern {
  label: string;
  regex: RegExp;
  /** How many hits before this pattern counts as a signal. */
  threshold: number;
  /**
   * A match containing this is discarded. Used where a pattern is shaped right
   * but catches ordinary document language.
   */
  reject?: RegExp;
  /**
   * This pattern only counts when some OTHER pattern also fired.
   *
   * For evidence too weak to stand alone. A capitalised phrase after the word
   * "patient" is a name in a case file and a heading in a lab manual, and no
   * amount of pattern-tuning separates those two — "Patient Inoculum
   * Suspensions" is real text from a real document that matched. What actually
   * distinguishes a record from a document that merely mentions people is the
   * machinery around the name: a date of birth, a record number, a phone
   * number. So names corroborate; they do not accuse.
   */
  requiresCorroboration?: boolean;
}

/**
 * Capitalised words that appear where a surname would sit but are not names.
 *
 * "Customer Account Summary" and "Patient Record Number" are section headings
 * in documents everywhere. This list catches the common ones, but it is only a
 * first pass and cannot be completed: every domain has its own vocabulary, and
 * no list was ever going to contain "Patient Inoculum Suspensions". The real
 * defence is the corroboration rule below.
 */
const DOCUMENT_NOUNS =
  /\b(Record|Records|Account|Accounts|Number|Numbers|Summary|Name|Names|Portal|Chart|Charts|History|Information|Details|Statement|Statements|Balance|Payment|Payments|Notice|Consent|Intake|Registration|Eligibility|Insurance|Billing|Service|Services|Order|Orders|Ticket|Tickets|Encounter|Encounters|Appointment|Appointments|Visit|Visits|Care|Data|File|Files|Form|Forms|Type|Types|Status|List|Lists|Report|Reports|Access|Rights|Safety|Group|Groups|Volume|Count|Counts|Profile|Profiles|Case|Cases|Contact|Contacts)\b/;

/** Role words a real name tends to follow, across industries. */
const ROLE = "(?:[Pp]atient|[Pp]t\\.?|[Cc]lient|[Cc]ustomer|[Mm]ember|[Ee]mployee|[Rr]esident|[Aa]pplicant|[Ss]ubscriber|[Tt]enant|[Ss]tudent)";
const TITLE = "(?:[MmDd][rs]?s?\\.?\\s+)?";
const FULL_NAME = "[A-Z][a-z]{2,}\\s+[A-Z][a-z]{2,}";

const PATTERNS: Pattern[] = [
  {
    label: "Dates of birth",
    regex: /\b(dob|date of birth|birth ?date)\b[\s:]*[0-9]{1,4}[-/][0-9]{1,2}[-/][0-9]{1,4}/gi,
    threshold: 1,
  },
  {
    label: "Record or account numbers",
    // One category for every sector's internal identifier: a clinic's MRN, a
    // bank's customer number, an insurer's policy number, a school's student
    // number. The shape is the same and so is the risk.
    // The value must CONTAIN A DIGIT. Without that, "Record Number appears on
    // every statement" matches — the label is there and "appears" satisfies a
    // bare [a-z0-9-]{4,}. An identifier has digits in it; a sentence does not.
    regex: /\b(mrn|medical record (?:no|number|#)|record (?:no|number|#)|account (?:no|number|#)|customer (?:no|number|#)|member (?:no|number|#)|case (?:no|number|#)|file (?:no|number|#)|policy (?:no|number|#)|student (?:no|number|#)|reference (?:no|number|#))\b[\s:#]*(?=[a-z0-9-]{4,})[a-z-]*\d[a-z0-9-]*/gi,
    threshold: 1,
  },
  {
    label: "Government identification numbers",
    // Social security / social insurance / national insurance shapes.
    regex: /\b\d{3}[- ]\d{2}[- ]\d{4}\b|\b\d{3}[- ]\d{3}[- ]\d{3}\b/g,
    threshold: 1,
  },
  {
    label: "Payment card numbers",
    regex: /\b(?:\d{4}[- ]){3}\d{4}\b/g,
    threshold: 1,
  },
  {
    label: "Named individuals",
    // A capitalised full name directly after a role word, so ordinary prose
    // about "the customer" is not flagged.
    //
    // The case handling is fiddly and was wrong twice. The role word must match
    // both cases, but the NAME must stay strictly capitalised — and an /i flag
    // applies to the whole pattern, making [A-Z] match lowercase and turning
    // this into "any two words after the word customer". So the role word
    // carries its own character classes and there is no /i.
    regex: new RegExp(`\\b${ROLE}\\s+${TITLE}${FULL_NAME}`, "g"),
    threshold: 2,
    reject: DOCUMENT_NOUNS,
    requiresCorroboration: true,
  },
  {
    label: "Contact details",
    regex: /\b[\w.%+-]+@[\w.-]+\.[a-z]{2,}\b|\b\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b/gi,
    threshold: 3,
  },
];

/**
 * Scanning a whole 200-page document is wasteful and the signal is the same:
 * if identifiers are present at all, they are present in the first stretch.
 */
const SCAN_LIMIT = 200_000;

export function scanForSensitiveData(text: string): SensitiveScanResult {
  const sample = (text || "").slice(0, SCAN_LIMIT);

  const hits: Array<{ pattern: Pattern; count: number }> = [];

  for (const pattern of PATTERNS) {
    // Reset lastIndex: these are module-level regexes with /g, and a stale
    // lastIndex silently skips the start of the next document.
    pattern.regex.lastIndex = 0;
    const raw = sample.match(pattern.regex) || [];
    const matches = pattern.reject
      ? raw.filter((m) => !pattern.reject!.test(m))
      : raw;

    if (matches.length >= pattern.threshold) {
      hits.push({ pattern, count: matches.length });
    }
  }

  // A weak pattern needs a strong one beside it. Without this, one lab manual
  // heading repeated twice flags a 40-page procedure document as carrying
  // personal data — and a scanner that cries wolf on ordinary content is one
  // people learn to click past, which costs more than it ever catches.
  const standalone = hits.filter((h) => !h.pattern.requiresCorroboration);
  const kept = standalone.length > 0 ? hits : standalone;

  return {
    atRisk: kept.length > 0,
    findings: kept.map(
      (h) => `${h.pattern.label} (${h.count} occurrence${h.count === 1 ? "" : "s"})`
    ),
  };
}
