export type DaemonIpcFetch = (
  port: number,
  path: string,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Verify that the selected notifier bot can currently see the destination.
 *
 * The daemon's `/api/groups` payload is built from that bot's own paginated
 * `im/v1/chats` list, so an exact chat-id hit proves the bot is a member.  Keep
 * this check fail-closed: an offline daemon, HTTP error or malformed snapshot
 * must never persist an unverified external delivery target.
 */
export async function daemonListsChat(
  fetchDaemonIpc: DaemonIpcFetch,
  ipcPort: number,
  targetChatId: string,
): Promise<boolean> {
  try {
    const response = await fetchDaemonIpc(ipcPort, '/api/groups', {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return false;
    const body = await response.json().catch(() => null) as { chats?: unknown } | null;
    if (!Array.isArray(body?.chats)) return false;
    return body.chats.some(chat => (
      typeof chat === 'object'
      && chat !== null
      && (chat as { chatId?: unknown }).chatId === targetChatId
    ));
  } catch {
    return false;
  }
}
