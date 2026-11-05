export interface SpeechPronunciationEntry {
  id: string
  text: string
  pinyin: string
}

export const SPEECH_PRONUNCIATION_LIMITS = { entries: 200, text: 32, pinyin: 128, bodyBytes: 96 * 1024 } as const

// Mandarin syllables, using v for ü. Tones are supplied separately as digits 1–5.
const syllables = new Set(('a ai an ang ao ba bai ban bang bao bei ben beng bi bian biao bie bin bing bo bu ca cai can cang cao ce cen ceng cha chai chan chang chao che chen cheng chi chong chou chu chua chuai chuan chuang chui chun chuo ci cong cou cu cuan cui cun cuo da dai dan dang dao de dei den deng di dia dian diao die ding diu dong dou du duan dui dun duo e ei en eng er fa fan fang fei fen feng fo fou fu ga gai gan gang gao ge gei gen geng gong gou gu gua guai guan guang gui gun guo ha hai han hang hao he hei hen heng hong hou hu hua huai huan huang hui hun huo ji jia jian jiang jiao jie jin jing jiong jiu ju juan jue jun ka kai kan kang kao ke kei ken keng kong kou ku kua kuai kuan kuang kui kun kuo la lai lan lang lao le lei leng li lia lian liang liao lie lin ling liu lo long lou lu luan lun luo lv lve ma mai man mang mao me mei men meng mi mian miao mie min ming miu mo mou mu na nai nan nang nao ne nei nen neng ni nian niang niao nie nin ning niu nong nou nu nuan nuo nv nve o ou pa pai pan pang pao pei pen peng pi pian piao pie pin ping po pou pu qi qia qian qiang qiao qie qin qing qiong qiu qu quan que qun ran rang rao re ren reng ri rong rou ru ruan rui run ruo sa sai san sang sao se sen seng sha shai shan shang shao she shei shen sheng shi shou shu shua shuai shuan shuang shui shun shuo si song sou su suan sui sun suo ta tai tan tang tao te teng ti tian tiao tie ting tong tou tu tuan tui tun tuo wa wai wan wang wei wen weng wo wu xi xia xian xiang xiao xie xin xing xiong xiu xu xuan xue xun ya yan yang yao ye yi yin ying yo yong you yu yuan yue yun za zai zan zang zao ze zei zen zeng zha zhai zhan zhang zhao zhe zhei zhen zheng zhi zhong zhou zhu zhua zhuai zhuan zhuang zhui zhun zhuo zi zong zou zu zuan zui zun zuo').split(' '))

export class SpeechPronunciationError extends Error {
  readonly code: string
  constructor(message: string, code = 'tts-invalid-pronunciations') {
    super(message)
    this.code = code
  }
}

export function validateSpeechPronunciations(value: unknown): SpeechPronunciationEntry[] {
  const invalid = () => { throw new SpeechPronunciationError('Invalid pronunciation dictionary') }
  if (!Array.isArray(value) || value.length > SPEECH_PRONUNCIATION_LIMITS.entries) return invalid()
  const texts = new Set<string>()
  const ids = new Set<string>()
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return invalid()
    const item = entry as Record<string, unknown>
    if (Object.keys(item).some((key) => !['id', 'text', 'pinyin'].includes(key))
      || typeof item.id !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(item.id)
      || typeof item.text !== 'string' || !/^\p{Script=Han}+$/u.test(item.text)
      || [...item.text].length > SPEECH_PRONUNCIATION_LIMITS.text
      || typeof item.pinyin !== 'string' || item.pinyin.length > SPEECH_PRONUNCIATION_LIMITS.pinyin) return invalid()
    const pinyin = item.pinyin.trim().toLowerCase()
    const parts = pinyin.split(/ +/)
    if (parts.length !== [...item.text].length || parts.some((part) => !/^[a-z]+[1-5]$/.test(part) || !syllables.has(part.slice(0, -1)))
      || texts.has(item.text) || ids.has(item.id)) return invalid()
    texts.add(item.text)
    ids.add(item.id)
    return { id: item.id, text: item.text, pinyin: parts.join(' ') }
  })
}

/** Longest word first, then position and lexical order; independent of saved order. */
export function matchSpeechPronunciations(text: string, entries: readonly SpeechPronunciationEntry[]): string[] {
  const candidates = entries.flatMap((entry) => {
    const matches: { entry: SpeechPronunciationEntry; start: number; end: number }[] = []
    for (let start = text.indexOf(entry.text); start >= 0; start = text.indexOf(entry.text, start + 1)) {
      matches.push({ entry, start, end: start + entry.text.length })
    }
    return matches
  }).sort((a, b) => b.entry.text.length - a.entry.text.length || a.start - b.start || (a.entry.text < b.entry.text ? -1 : 1))
  const accepted: typeof candidates = []
  const used = new Map<string, SpeechPronunciationEntry>()
  for (const candidate of candidates) {
    if (accepted.some((other) => candidate.start < other.end && candidate.end > other.start)) continue
    accepted.push(candidate)
    used.set(candidate.entry.text, candidate.entry)
  }
  return [...used.values()].sort((a, b) => b.text.length - a.text.length || (a.text < b.text ? -1 : 1))
    .map((entry) => `${entry.text}/${entry.pinyin.split(' ').map((part) => `(${part})`).join('')}`)
}
