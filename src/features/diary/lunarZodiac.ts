export interface LunarZodiacIcon {
  src: string
  alt: string
}

const LUNAR_ZODIAC_ICONS: Readonly<Record<string, LunarZodiacIcon>> = Object.freeze({
  鼠: { src: '/emoji/zodiac-rat.svg', alt: '生肖：鼠' },
  牛: { src: '/emoji/zodiac-ox.svg', alt: '生肖：牛' },
  虎: { src: '/emoji/zodiac-tiger.svg', alt: '生肖：虎' },
  兔: { src: '/emoji/zodiac-rabbit.svg', alt: '生肖：兔' },
  龙: { src: '/emoji/zodiac-dragon.svg', alt: '生肖：龙' },
  蛇: { src: '/emoji/zodiac-snake.svg', alt: '生肖：蛇' },
  马: { src: '/emoji/zodiac-horse.svg', alt: '生肖：马' },
  羊: { src: '/emoji/zodiac-goat.svg', alt: '生肖：羊' },
  猴: { src: '/emoji/zodiac-monkey.svg', alt: '生肖：猴' },
  鸡: { src: '/emoji/zodiac-rooster.svg', alt: '生肖：鸡' },
  狗: { src: '/emoji/zodiac-dog.svg', alt: '生肖：狗' },
  猪: { src: '/emoji/zodiac-pig.svg', alt: '生肖：猪' },
})

export function lunarZodiacIcon(zodiac: string): LunarZodiacIcon | null {
  return LUNAR_ZODIAC_ICONS[zodiac] ?? null
}
