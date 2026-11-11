export interface CspOptions {
  nonce: string;
  isDev: boolean;
  /** Origins forms may submit or redirect to: the identity provider for login and logout. */
  formActionOrigins: string[];
}

/**
 * Strict Content Security Policy with a per-request nonce for scripts.
 * Styles allow inline style attributes, which Radix uses for positioning;
 * no nonce is listed for styles, because a nonce would disable that.
 */
export function buildContentSecurityPolicy({ nonce, isDev, formActionOrigins }: CspOptions): string {
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    ["form-action 'self'", ...formActionOrigins].join(" "),
    "frame-ancestors 'none'",
  ];
  if (!isDev) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}

/** The origin of a URL, or undefined if it is not a valid http(s) URL. */
export function originOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}
