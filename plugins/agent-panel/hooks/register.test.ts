import { expect, test } from 'claude-code/testing'

import { DEFAULT_FRAMES, FRAMES } from './register'

const PANE = {
  plugin: 'agent-panel',
  component: 'Pane',
  requestId: 'agent-panel',
  props: { title: '에이전트', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
  surface: 'desktop',
} as const

test('캐릭터는 한 글자이고 두 칸이 될 수 있는 글자를 쓰지 않는다', () => {
  const ambiguous = /[àáæè-êìíðòó÷-úüþ]/ // 동아시아 모호 폭(Latin-1)
  for (const set of [...Object.values(FRAMES), DEFAULT_FRAMES]) {
    for (const ch of set) {
      expect([...ch].length).toBe(1)
      expect(ambiguous.test(ch)).toBe(false)
    }
  }
})

test('에이전트가 없으면 안내 문구를 그린다', async ($, on) => {
  on('clock.every', () => ({ value: { cancel: () => {} } }) as any)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'agent_panel' } }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount(PANE as any)
  expect((await ui.find({ type: 'Text', text: /하위 에이전트가 없습니다/ }))?.text).toBeDefined()
  await ui.unmount()
})

test('시작한 에이전트와 도구 호출 수를 한 줄로 그린다', async ($, on) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'agent_panel' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.now', () => ({ value: Date.now() }))
  on('clock.every', () => ({ value: { cancel: () => {} } }) as any)
  on('agent.spawn', () => ({ agentId: 'a1', model: 'x' }) as any)
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  await $.agent.spawn({ tool_use_id: 't1', prompt: 'p', description: '코드 탐색', subagentType: 'Explore' } as any)
  await $.tool.call({ tool: 'Grep', agentId: 'a1' } as any)
  await $.tool.call({ tool: 'Read', agentId: 'a1' } as any)

  const ui = await $.ui.mount(PANE as any)
  const row = await ui.find({ type: 'Text', text: /코드 탐색/ })
  expect(row?.text).toContain('Explore')
  expect(row?.text).toContain('2회 Read')
  await ui.unmount()
})
