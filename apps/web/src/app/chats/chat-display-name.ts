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
  return managementNickname?.trim() || lineDisplayName?.trim() || fallback
}
