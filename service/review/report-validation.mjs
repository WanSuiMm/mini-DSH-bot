const REPORT_KEYS = new Set(['base', 'head', 'findings', 'limitations']);
const FINDING_KEYS = new Set(['severity', 'file', 'line', 'title', 'description', 'evidence']);
const SEVERITIES = new Set(['critical', 'high', 'medium', 'low']);
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;

export class ReviewReportValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ReviewReportValidationError';
    this.code = code;
  }
}

/**
 * Validate and copy a model-produced JSON report against the local snapshot.
 * This proves that references and excerpts are real changed-line evidence; it
 * cannot prove that a model's semantic interpretation of the code is correct.
 */
export function validateReviewReport(value, snapshot, limits = {}) {
  const maxFindings = limits.maxFindings ?? 50;
  const maxLimitations = limits.maxLimitations ?? 10;
  if (!Number.isSafeInteger(maxFindings) || maxFindings < 0 || maxFindings > 200) throw new TypeError('maxFindings must be from 0 through 200');
  if (!Number.isSafeInteger(maxLimitations) || maxLimitations < 1 || maxLimitations > 50) throw new TypeError('maxLimitations must be from 1 through 50');
  if (!isRecord(snapshot) || !SHA.test(snapshot.base ?? '') || !SHA.test(snapshot.head ?? '') || !Array.isArray(snapshot.files)) {
    throw validationError('INVALID_SNAPSHOT', 'A validated local Git snapshot is required.');
  }
  if (!isRecord(value) || !hasExactKeys(value, REPORT_KEYS)) {
    throw validationError('INVALID_REPORT', 'The report must contain only base, head, findings, and limitations.');
  }
  if (typeof value.base !== 'string' || !SHA.test(value.base) || value.base.toLowerCase() !== snapshot.base.toLowerCase()) {
    throw validationError('INVALID_BASE', 'The report base SHA does not match the fixed review snapshot.');
  }
  if (typeof value.head !== 'string' || !SHA.test(value.head) || value.head.toLowerCase() !== snapshot.head.toLowerCase()) {
    throw validationError('INVALID_HEAD', 'The report head SHA does not match the fixed review snapshot.');
  }
  if (!Array.isArray(value.findings) || value.findings.length > maxFindings) {
    throw validationError('INVALID_FINDINGS', `findings must be an array with at most ${maxFindings} entries.`);
  }
  if (!Array.isArray(value.limitations) || value.limitations.length < 1 || value.limitations.length > maxLimitations) {
    throw validationError('INVALID_LIMITATIONS', `limitations must contain 1 through ${maxLimitations} entries.`);
  }

  const lineEvidence = new Map();
  for (const file of snapshot.files) {
    if (!isRecord(file) || typeof file.path !== 'string' || !Array.isArray(file.addedLines)) continue;
    for (const entry of file.addedLines) {
      if (isRecord(entry) && Number.isSafeInteger(entry.line) && entry.line > 0 && typeof entry.text === 'string') {
        lineEvidence.set(`${file.path}\0${entry.line}`, entry.text);
      }
    }
  }

  const findings = [];
  const uniqueFindings = new Set();
  for (let index = 0; index < value.findings.length; index += 1) {
    const finding = value.findings[index];
    if (!isRecord(finding) || !hasExactKeys(finding, FINDING_KEYS)) {
      throw validationError('INVALID_FINDING', `Finding ${index + 1} must contain only severity, file, line, title, description, and evidence.`);
    }
    if (typeof finding.severity !== 'string' || !SEVERITIES.has(finding.severity)) {
      throw validationError('INVALID_SEVERITY', `Finding ${index + 1} has an unsupported severity.`);
    }
    const file = boundedText(finding.file, 1, 1024, `Finding ${index + 1} file`);
    if (file.includes('\\') || file.startsWith('/') || file.split('/').some(part => !part || part === '.' || part === '..')) {
      throw validationError('INVALID_FILE', `Finding ${index + 1} file must be a repository-relative path.`);
    }
    if (!Number.isSafeInteger(finding.line) || finding.line < 1) {
      throw validationError('INVALID_LINE', `Finding ${index + 1} line must be a positive one-based integer.`);
    }
    const sourceLine = lineEvidence.get(`${file}\0${finding.line}`);
    if (sourceLine === undefined) {
      throw validationError('UNVERIFIED_ANCHOR', `Finding ${index + 1} does not point to an added line in the fixed head commit.`);
    }
    const title = boundedText(finding.title, 1, 200, `Finding ${index + 1} title`);
    const description = boundedText(finding.description, 1, 1200, `Finding ${index + 1} description`);
    const evidence = boundedText(finding.evidence, 1, 320, `Finding ${index + 1} evidence`);
    if (!sourceLine.includes(evidence)) {
      throw validationError('UNVERIFIED_EVIDENCE', `Finding ${index + 1} evidence is not an exact substring of its changed line.`);
    }
    const key = `${file}\0${finding.line}\0${finding.severity}\0${title.toLowerCase()}`;
    if (uniqueFindings.has(key)) throw validationError('DUPLICATE_FINDING', `Finding ${index + 1} duplicates an earlier finding.`);
    uniqueFindings.add(key);
    findings.push({ severity: finding.severity, file, line: finding.line, title, description, evidence });
  }

  const limitations = value.limitations.map((text, index) => boundedText(text, 1, 500, `Limitation ${index + 1}`));
  return Object.freeze({
    base: snapshot.base.toLowerCase(),
    head: snapshot.head.toLowerCase(),
    findings: Object.freeze(findings.map(finding => Object.freeze(finding))),
    limitations: Object.freeze(limitations),
  });
}

export function parseAndValidateReviewReport(text, snapshot, limits) {
  if (typeof text !== 'string' || text.length > 32_000) throw validationError('REPORT_SIZE_LIMIT', 'Model report text must be at most 32000 characters.');
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw validationError('INVALID_JSON', 'The model response was not one complete JSON report.'); }
  return validateReviewReport(parsed, snapshot, limits);
}

function boundedText(value, min, max, label) {
  if (typeof value !== 'string') throw validationError('INVALID_TEXT', `${label} must be text.`);
  const text = value.trim();
  if (text.length < min || text.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) {
    throw validationError('INVALID_TEXT', `${label} must contain ${min} through ${max} safe characters.`);
  }
  return text;
}

function hasExactKeys(value, allowed) {
  return Object.keys(value).length === allowed.size && Object.keys(value).every(key => allowed.has(key));
}

function isRecord(value) { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function validationError(code, message) { return new ReviewReportValidationError(code, message); }
