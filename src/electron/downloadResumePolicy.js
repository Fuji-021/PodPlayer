export function inspectRangeResponse(status, contentRange, rangeStart) {
  if (status !== 206) return { ok: false, error: 'range-status' };
  const match = String(contentRange || '').match(
    /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i
  );
  if (!match || Number(match[1]) !== rangeStart) {
    return { ok: false, error: 'range-mismatch' };
  }
  return {
    ok: true,
    total: match[3] === '*' ? 0 : Number(match[3]) || 0,
  };
}
