import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { atomicWriteFileSync } from '../../utils/atomic-write.js';
import { withFileLockSync } from '../../utils/file-lock.js';
import { larkPluginMessageClaimsPath } from './paths.js';

interface MessageClaim {
  pluginId: string;
  larkAppId: string;
  chatId: string;
  rootMessageId: string;
  aliases: string[];
  claimedAt: number;
}

interface ClaimFile {
  version: 1;
  claims: Record<string, MessageClaim>;
  exclusiveChats?: Record<string, ExclusiveChatClaim>;
}

interface ExclusiveChatClaim {
  pluginId: string;
  larkAppId: string;
  chatId: string;
  claimedAt: number;
}

export interface ClaimInput {
  pluginId: string;
  larkAppId: string;
  chatId: string;
  rootMessageId: string;
  aliases?: readonly string[];
}

export interface ResolvedMessageClaim {
  pluginId: string;
  rootMessageId: string;
}

function key(larkAppId: string, rootMessageId: string): string {
  return `${larkAppId}\u0000${rootMessageId}`;
}

function chatKey(larkAppId: string, chatId: string): string {
  return `${larkAppId}\u0000${chatId}`;
}

function validString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function validateFile(value: unknown): value is ClaimFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const file = value as Partial<ClaimFile>;
  if (file.version !== 1 || !file.claims || typeof file.claims !== 'object' || Array.isArray(file.claims)) {
    return false;
  }
  const validClaims = Object.values(file.claims).every(claim => !!claim
    && typeof claim === 'object'
    && validString(claim.pluginId)
    && validString(claim.larkAppId)
    && validString(claim.chatId)
    && validString(claim.rootMessageId)
    && Array.isArray(claim.aliases)
    && claim.aliases.every(validString)
    && typeof claim.claimedAt === 'number');
  const exclusiveChats = file.exclusiveChats;
  const validChats = exclusiveChats === undefined || (
    typeof exclusiveChats === 'object'
    && !Array.isArray(exclusiveChats)
    && Object.values(exclusiveChats).every(claim => !!claim
      && typeof claim === 'object'
      && validString(claim.pluginId)
      && validString(claim.larkAppId)
      && validString(claim.chatId)
      && typeof claim.claimedAt === 'number')
  );
  return validClaims && validChats;
}

/** Durable routing tombstones for roots whose replies belong exclusively to a
 * plugin. Claims intentionally outlive plugin disable/uninstall so an old card
 * can never fall through and create an unrelated native BotMux session. */
export class LarkPluginMessageClaimStore {
  constructor(private readonly path = larkPluginMessageClaimsPath()) {}

  private read(): ClaimFile {
    if (!existsSync(this.path)) return { version: 1, claims: {} };
    const parsed: unknown = JSON.parse(readFileSync(this.path, 'utf8'));
    if (!validateFile(parsed)) throw new Error('invalid_lark_plugin_message_claims');
    return { ...parsed, exclusiveChats: parsed.exclusiveChats ?? {} };
  }

  /** Explicitly reserves a dedicated chat before the first provider send.
   * This is intentionally separate from root claims: one historical card must
   * never silently turn an ordinary BotMux chat into a plugin-only chat. */
  claimExclusiveChat(pluginId: string, larkAppId: string, chatId: string): void {
    if (![pluginId, larkAppId, chatId].every(validString)) {
      throw new Error('invalid_lark_plugin_exclusive_chat_claim');
    }
    mkdirSync(dirname(this.path), { recursive: true });
    withFileLockSync(this.path, () => {
      const file = this.read();
      file.exclusiveChats ??= {};
      const existing = file.exclusiveChats[chatKey(larkAppId, chatId)];
      if (existing && existing.pluginId !== pluginId) {
        throw new Error('lark_plugin_exclusive_chat_already_claimed');
      }
      file.exclusiveChats[chatKey(larkAppId, chatId)] = {
        pluginId,
        larkAppId,
        chatId,
        claimedAt: existing?.claimedAt ?? Date.now(),
      };
      atomicWriteFileSync(this.path, `${JSON.stringify(file, null, 2)}\n`, {
        mode: 0o600,
        durable: true,
      });
    });
  }

  claim(input: ClaimInput): void {
    const required = [input.pluginId, input.larkAppId, input.chatId, input.rootMessageId];
    if (!required.every(validString)) throw new Error('invalid_lark_plugin_message_claim');
    mkdirSync(dirname(this.path), { recursive: true });
    withFileLockSync(this.path, () => {
      const file = this.read();
      const aliases = [...new Set((input.aliases ?? []).filter(validString))];
      file.claims[key(input.larkAppId, input.rootMessageId)] = {
        pluginId: input.pluginId,
        larkAppId: input.larkAppId,
        chatId: input.chatId,
        rootMessageId: input.rootMessageId,
        aliases,
        claimedAt: Date.now(),
      };
      atomicWriteFileSync(this.path, `${JSON.stringify(file, null, 2)}\n`, {
        mode: 0o600,
        durable: true,
      });
    });
  }

  resolve(larkAppId: string, messageIdentity: string): ResolvedMessageClaim | undefined {
    if (!validString(larkAppId) || !validString(messageIdentity)) return undefined;
    const claim = Object.values(this.read().claims).find(candidate => candidate.larkAppId === larkAppId
      && (candidate.rootMessageId === messageIdentity || candidate.aliases.includes(messageIdentity)));
    return claim ? { pluginId: claim.pluginId, rootMessageId: claim.rootMessageId } : undefined;
  }

  hasExclusiveChat(larkAppId: string, chatId: string): boolean {
    if (!validString(larkAppId) || !validString(chatId)) return false;
    return !!this.read().exclusiveChats?.[chatKey(larkAppId, chatId)];
  }
}
