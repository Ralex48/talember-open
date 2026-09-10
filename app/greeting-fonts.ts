export const fontNames = { classic: 'Classic', fredoka: 'Fredoka', pacifico: 'Pacifico', lobster: 'Lobster', caveat: 'Caveat' };
export type GreetingFont = keyof typeof fontNames;
export function fontSupports(font: string, text: string): font is GreetingFont {
  if (!Object.hasOwn(fontNames, font)) return false;
  if (font === 'fredoka' && /\p{Script=Cyrillic}/u.test(text)) return false;
  if (font !== 'fredoka' && font !== 'classic' && /\p{Script=Hebrew}/u.test(text)) return false;
  return true;
}
export const fontLabel = { en: 'Greeting font', ru: 'Шрифт пожелания', es: 'Fuente del mensaje', he: 'גופן הברכה' };
