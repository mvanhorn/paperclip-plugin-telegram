export function resolvePaperclipApiBaseUrl(baseUrl: string, publicUrl?: string): string {
  return (publicUrl?.trim() || baseUrl || "http://localhost:3100").replace(/\/$/, "");
}
