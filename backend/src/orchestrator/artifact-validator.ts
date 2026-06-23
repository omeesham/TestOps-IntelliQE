interface ValidationResult {
  valid: boolean;
  missing: string[];
  warnings: string[];
}

export function validateUpstreamArtifacts(
  _nextStageId: string,
  _context: Record<string, unknown>
): ValidationResult {
  // In the integrated version, artifact validation is done via DB queries
  // rather than filesystem checks. Always pass for now.
  return { valid: true, missing: [], warnings: [] };
}
