import DefaultTheme from 'vitepress/theme'
import './custom.css'
import ShlinkDebugger from './components/ShlinkDebugger.vue'

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('ShlinkDebugger', ShlinkDebugger)
  },
}
