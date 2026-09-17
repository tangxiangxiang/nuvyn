// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { NNumberAnimation as NumberAnimation } from 'naive-ui'
import { describe, expect, it } from 'vitest'
import LedgerAnimatedMoney from '../LedgerAnimatedMoney.vue'

describe('LedgerAnimatedMoney', () => {
  it('starts core metric animations from zero without a delayed reset', () => {
    const wrapper = mount(LedgerAnimatedMoney, {
      props: { minor: 996_200, currency: 'CNY', animateOnMount: true },
    })
    const animation = wrapper.findComponent(NumberAnimation)

    expect(animation.props('from')).toBe(0)
    expect(animation.props('to')).toBe(9962)

    wrapper.unmount()
  })

  it('formats static record values exactly without using number animation', async () => {
    const staticWrapper = mount(LedgerAnimatedMoney, {
      props: {
        minor: -3_800,
        currency: 'CNY',
        signed: true,
        animateOnMount: false,
        animateOnChange: false,
      },
    })
    expect(staticWrapper.findComponent(NumberAnimation).exists()).toBe(false)
    expect(staticWrapper.text()).toContain('-¥38.00')

    await staticWrapper.setProps({ minor: -13_000 })
    expect(staticWrapper.findComponent(NumberAnimation).exists()).toBe(false)
    expect(staticWrapper.text()).toContain('-¥130.00')
    staticWrapper.unmount()
  })

  it('preserves update animations when only mount animation is disabled', async () => {
    const animatedWrapper = mount(LedgerAnimatedMoney, {
      props: { minor: 120_000, currency: 'CNY', animateOnMount: false },
    })
    await animatedWrapper.setProps({ minor: 130_000 })
    const animatedAnimation = animatedWrapper.findComponent(NumberAnimation)
    expect(animatedAnimation.props('from')).toBe(1200)
    expect(animatedAnimation.props('to')).toBe(1300)
    animatedWrapper.unmount()
  })
})
