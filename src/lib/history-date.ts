export function historyLocale(locale: string): string {
  return locale === 'zh' ? 'zh-CN' : 'en-US'
}

export function formatHistoryDate(timestamp: number, locale: string): string {
  return new Intl.DateTimeFormat(historyLocale(locale), {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(timestamp)
}
