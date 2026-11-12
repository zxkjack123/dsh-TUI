/**
 * Approval withdrawal + background visibility regression.
 *
 * `approval/request` is answered by several surfaces at once: the harness
 * aborts the request-scoped signal as soon as ANY answerer decides (the web
 * UI, another plugin, the caller giving up). The TUI parks its own copy of
 * every ask, so that abort is the only observable "answered elsewhere" point —
 * and a parked copy whose removal is not pushed to subscribers keeps the
 * panel and the needs-input badge on screen until some unrelated mutation
 * happens.
 *
 * Also covers the visibility half: a background session's ask parks for the
 * panel and the badge, and its FIRST ask announces itself so an unattended
 * session cannot go unnoticed for as long as nobody looks at the badge.
 *
 * Run: node --import tsx/esm scripts/verify-approval-withdrawal.ts
 */

import assert from 'node:assert/strict'

const [{ ApprovalStore }, { backgroundApprovalLane, takeBackgroundApprovalNotice }] = await Promise.all([
  import('../src/dsh-adapter/approvals.js'),
  import('../src/dsh-adapter/plugin.js'),
])

type SessionEvent = { type: string; seq: number; time: number; data: Record<string, unknown> }

/** A minimal session log: one unresolved tool call for `callId`. */
function events(callId: string): SessionEvent[] {
  return [
    {
      type: 'tool/call',
      seq: 1,
      time: Date.now() - 2000,
      data: { turn: 1, step: 1, callId, name: 'Bash', arguments: JSON.stringify({ command: 'npm run build' }) },
    },
  ]
}

/** One approval request, with an optional withdrawal signal. */
function approvalRequest(
  callId: string,
  signal: AbortSignal | undefined,
  agentId = 'agent-1',
  toolName = 'Bash',
): never {
  return {
    agent: { id: agentId, session: { id: agentId, seq: 2, events: events(callId) } },
    toolName,
    callId,
    reason: 'needs approval',
    ...(signal === undefined ? {} : { signal }),
  } as never
}

/** Count subscriber pushes, so a silent store mutation is visible here. */
function counted(store: InstanceType<typeof ApprovalStore>): () => number {
  let pushes = 0
  store.subscribe(() => { pushes += 1 })
  return () => pushes
}

// ── Another surface answers the ask that is on the panel ──────────────────
{
  const store = new ApprovalStore()
  const controller = new AbortController()
  const pushes = counted(store)
  const outcome = store.park(approvalRequest('call-active', controller.signal))
  assert.notEqual(store.getSnapshot(), null, 'the ask is on the panel')
  const before = pushes()

  controller.abort()
  assert.equal(await outcome, 'cancelled', 'a withdrawn ask settles cancelled')
  assert.equal(store.getSnapshot(), null, 'the panel record is gone')
  assert.deepEqual(store.pendingAgentIds(), [], 'no agent is left waiting')
  assert.ok(pushes() > before, 'subscribers are pushed so the panel actually disappears')
}

// ── Another surface answers a QUEUED ask (the panel shows the first one) ──
{
  const store = new ApprovalStore()
  const first = new AbortController()
  const second = new AbortController()
  const pushes = counted(store)
  void store.park(approvalRequest('call-first', first.signal)).catch(() => 'cancelled')
  const queued = store.park(approvalRequest('call-second', second.signal, 'agent-2', 'Edit'))
  assert.deepEqual(store.pendingAgentIds(), ['agent-1', 'agent-2'], 'both agents wait')

  second.abort()
  assert.equal(await queued, 'cancelled', 'the queued ask settles cancelled')
  assert.deepEqual(store.pendingAgentIds(), ['agent-1'], 'the withdrawn agent stops waiting')
  assert.notEqual(store.getSnapshot(), null, 'the first ask still owns the panel')
  assert.ok(pushes() > 0, 'subscribers are pushed so the badge drops the agent')
}

// ── The ask is already withdrawn when it reaches the store ────────────────
{
  const store = new ApprovalStore()
  const controller = new AbortController()
  controller.abort()
  const outcome = store.park(approvalRequest('call-late', controller.signal))
  assert.equal(await outcome, 'cancelled', 'a pre-aborted ask settles immediately')
  assert.equal(store.getSnapshot(), null, 'it never reaches the panel')
  assert.deepEqual(store.pendingAgentIds(), [], 'it never lights the badge')
}

// ── Background visibility: first ask announces, later ones stay quiet ─────
{
  const seen = new Set<string>()
  const session = { title: 'main', backendId: 'dsh' }
  const first = takeBackgroundApprovalNotice(seen, { agentId: 'agent-bg', toolName: 'Bash', reason: 'risky' }, session)
  assert.notEqual(first, undefined, 'the first background ask announces itself')
  assert.equal(first!.sessionTitle, 'main (agent-bg)', 'the notice names the background agent')
  assert.equal(first!.toolName, 'Bash')
  assert.equal(first!.reason, 'risky', 'the asker reason rides along')
  assert.equal(first!.backendId, 'dsh')

  const second = takeBackgroundApprovalNotice(seen, { agentId: 'agent-bg', toolName: 'Edit' }, session)
  assert.equal(second, undefined, 'a later ask from the same agent does not to repeat the toast')

  const other = takeBackgroundApprovalNotice(seen, { agentId: 'agent-other', toolName: 'Bash' }, session)
  assert.notEqual(other, undefined, 'a different background agent still announces once')
  assert.equal(other!.reason, undefined, 'a missing reason is omitted')
}

// ── Background visibility: which surface speaks, per focus and setting ───
{
  const settings = (condition: 'off' | 'unfocused' | 'always') => ({ condition, method: 'auto' as const })
  assert.equal(backgroundApprovalLane(settings('off'), true, false), 'none', 'the off switch silences the announcement')
  assert.equal(backgroundApprovalLane(settings('off'), true, true), 'none', 'the off switch also silences the in-app toast')
  assert.equal(
    backgroundApprovalLane(settings('unfocused'), true, false),
    'notification',
    'away from the terminal the OS notification is the one that reaches the user',
  )
  assert.equal(
    backgroundApprovalLane(settings('unfocused'), true, true),
    'toast',
    'a focused terminal suppresses the OS path, so the in-app toast carries the ask',
  )
  assert.equal(backgroundApprovalLane(settings('always'), true, true), 'notification', 'always keeps the OS path')
}

console.log('verify-approval-withdrawal: ok')
