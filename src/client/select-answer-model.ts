import type { SidebarqaModelSelection, SidebarqaSessionRemote } from '../context-types.ts'
import type { SidebarqaConfigView } from './api.ts'
import { remoteErrorText, unwrapRemote } from './session-wire.ts'

export interface AnswerModelSelection {
  selection: SidebarqaModelSelection
  fallback: boolean
}

/** Pin a real child model before prompting; never silently use the global default.
 * Only an unavailable configured model may fall back. A deliberate panel pick,
 * transport error or missing parent is an error, not permission to change routes.
 * The host's selectModel also updates its default for future sessions.
 */
export async function selectAnswerModel(
  remote: SidebarqaSessionRemote,
  sessionId: string,
  config: SidebarqaConfigView,
  parent: SidebarqaModelSelection | undefined,
  override: SidebarqaModelSelection | undefined,
): Promise<AnswerModelSelection> {
  const selection: SidebarqaModelSelection = override ?? {
    provider: config.answerProvider,
    model: config.answerModel,
    reasoningEffort: config.answerReasoningEffort,
  }
  const result = await remote.selectModel({ sessionId, ...selection })
  if (result.ok) return { selection: result.value.selected, fallback: false }
  if (override === undefined && result.error.code === 'session/model-unavailable' && parent !== undefined) {
    const accepted = unwrapRemote(await remote.selectModel({ sessionId, ...parent }), 'select parent model')
    return { selection: accepted.selected, fallback: true }
  }
  throw new Error(`select answer model failed: ${remoteErrorText(result.error)}`)
}
