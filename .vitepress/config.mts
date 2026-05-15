import { defineConfig } from 'vitepress'

const repo = 'https://github.com/ktc-spec/ktc-spec.github.io'

export default defineConfig({
  lang: 'en-US',
  title: 'KTC Spec',
  description: 'Patient-Shared Health Documents via SMART Health Links',
  cleanUrls: true,
  lastUpdated: true,
  srcExclude: ['index-*.md'],
  markdown: {
    lineNumbers: true
  },
  themeConfig: {
    siteTitle: 'KTC Spec',
    nav: [
      { text: 'Spec', link: '/' },
      { text: 'Reference Implementation', link: 'https://pshd-shl.exe.xyz/prototype.html' },
      {
        text: 'Contribute',
        items: [
          { text: 'Report Issue', link: `${repo}/issues/new` },
          { text: 'Submit PR', link: `${repo}/compare` }
        ]
      }
    ],
    outline: {
      label: 'On this page',
      level: [2, 3]
    },
    search: {
      provider: 'local'
    },
    editLink: {
      pattern: `${repo}/edit/main/:path`,
      text: 'Suggest changes on GitHub'
    },
    socialLinks: [
      { icon: 'github', link: repo }
    ],
    footer: {
      message: 'Draft specification maintained on GitHub.'
    }
  }
})
