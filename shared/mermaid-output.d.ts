export type MermaidNormalization = { code: string; repairs: string[] };
export type MermaidEnvelopeValidation = { valid: true } | { valid: false; error: string };

export declare function normalizeMermaidOutput(value: unknown): MermaidNormalization;
export declare function validateMermaidEnvelope(code: string): MermaidEnvelopeValidation;
export declare function formatMermaidParseError(error: unknown): string;
