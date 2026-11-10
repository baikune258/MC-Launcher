import { defineAsyncComponent, defineComponent, h, type Component } from 'vue'

/** Lazy view loader with a visible failure state.
 *
 *  A rejected dynamic import used to leave the whole route area blank with no
 *  hint: the user saw an empty page and no error. Retry once (a chunk read can
 *  fail transiently on Windows when the antivirus scans the freshly written
 *  file), then render an explicit error card so the failure is reportable. */
const failed: Component = defineComponent({
  name: 'ViewLoadFailure',
  render: () => h('div', { class: 'card empty', style: 'display:flex;flex-direction:column;gap:8px;align-items:flex-start' }, [
    h('strong', '页面加载失败'),
    h('span', { class: 'muted' }, '这个页面没能加载出来，请重新进入；若一直失败，重启启动器后再试。')
  ])
})

export function asyncView(loader: () => Promise<{ default: Component }>): Component {
  return defineAsyncComponent({
    loader: async () => {
      try { return await loader() } catch (error) {
        console.error('[view] 加载失败，重试一次', error)
        return await loader()
      }
    },
    errorComponent: failed,
    timeout: 30_000
  })
}
