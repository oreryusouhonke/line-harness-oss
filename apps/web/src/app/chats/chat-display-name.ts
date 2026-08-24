interface ChatDisplayNameInput {
  lineDisplayName?: string | null
  managementNickname?: string | null
  fallback: string
}

export function resolveChatDisplayName({
  lineDisplayName,
  managementNickname,
  fallback,
}: ChatDisplayNameInput): string {
  // Prefer the staff-managed name and fall back to the LINE profile name.
  return managementNickname?.trim() || lineDisplayName?.trim() || fallback
}
