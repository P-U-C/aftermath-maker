export function parseNumericDraft(
  text: string,
  options: {
    label: string;
    unit: string;
    min: number;
    max: number;
    integer?: boolean;
  },
): { value: number | null; error: string | null } {
  const range = `${options.min}–${options.max} ${options.unit}`.trim();
  if (!text.trim())
    return { value: null, error: `${options.label} is required (${range}).` };
  const pattern = options.integer
    ? /^\+?\d+$/
    : /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
  if (!pattern.test(text.trim()))
    return {
      value: null,
      error: `${options.label} must be a finite ${options.integer ? "whole " : ""}number in ${range}.`,
    };
  const value = Number(text.trim());
  if (!Number.isFinite(value) || value < options.min || value > options.max)
    return {
      value: null,
      error: `${options.label} must be in ${range}; entered ${text}.`,
    };
  return { value, error: null };
}
