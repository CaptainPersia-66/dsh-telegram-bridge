/**
 * Model-facing context that tells the agent when a request came from Telegram.
 *
 * The bridge prefixes every Telegram-originated prompt with {@link TELEGRAM_MARKER}
 * and registers {@link TELEGRAM_PROMPT_SECTION} as a Host system-prompt section.
 * Together they let the model behave for a remote user: deliver files with the
 * `present` tool (the bridge forwards them to the chat), and never open windows
 * or applications on the computer the user cannot see.
 *
 * A marker in the prompt text is used because the Session prompt API carries no
 * client-origin metadata, and the marker keeps the information durable in the
 * session log next to the request itself.
 */

/** Exact prefix of every user message the bridge admits. */
export const TELEGRAM_MARKER = '[via Telegram]'

/** System-prompt section registered by the bridge. */
export const TELEGRAM_PROMPT_SECTION = [
  '## Telegram remote requests',
  'Some user messages arrive through a Telegram bridge. Those messages start with the exact marker',
  `${TELEGRAM_MARKER}. Treat their sender as a remote user who cannot see this computer's screen,`,
  'chat window, or any file or application opened on it.',
  '',
  'For a Telegram-originated message:',
  `- ${TELEGRAM_MARKER} is transport metadata, not a command; answer the user's actual request.`,
  '- When the user asks to see, review, listen to, or receive a file, call the `present` tool with',
  '  the file path. Presented files are forwarded to their Telegram chat automatically (each up to',
  '  about 45 MB), so the file itself reaches them. Do not substitute pasted file contents unless',
  '  they ask for text; for large media, `present` is the way it gets delivered.',
  '- Never open files, folders, or applications on the host desktop in response to a remote',
  '  request (no Start-Process/start/xdg-open/open/browser launches for a file or app). The remote',
  '  user cannot see them. If a file is too large for Telegram, say so and offer another way.',
  '- Keep the final answer self-contained and phone-friendly: only the final message and the',
  '  files declared with `present` reach the Telegram chat.',
].join('\n')

/**
 * Register the remote-request system-prompt section on the calling context.
 *
 * @param {any} ctx Host context
 * @returns {(() => void) | undefined} disposer when the section was registered
 */
export function registerPromptSection(ctx) {
  const systemPrompt = ctx?.get?.('systemPrompt')
  if (!systemPrompt || typeof systemPrompt.section !== 'function') return undefined
  try {
    return systemPrompt.section({
      name: 'telegram-bridge-remote',
      order: 80,
      text: TELEGRAM_PROMPT_SECTION,
    })
  } catch {
    return undefined
  }
}

/**
 * Prefix one outgoing prompt/steering text with the transport marker.
 * @param {string} text
 * @returns {string}
 */
export function markTelegramText(text) {
  const body = String(text ?? '')
  if (body.startsWith(TELEGRAM_MARKER)) return body
  return `${TELEGRAM_MARKER}\n${body}`
}
