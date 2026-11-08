// Prompt-based styles owned by the extension. They are not Perchance Professional model IDs.
export const BUILTIN_STYLES = Object.freeze([
  { id: 'none', name: 'Без стиля', positive: '', negative: '' },
  { id: 'photo', name: 'Фотореализм', positive: 'photorealistic photography, realistic skin texture, natural lighting, authentic lens detail', negative: 'cartoon, anime, illustration, painting, CGI' },
  { id: 'cinematic', name: 'Кино', positive: 'cinematic film still, dramatic lighting, atmospheric composition, detailed production design', negative: 'flat lighting, cartoon, cheap render' },
  { id: 'anime', name: 'Аниме', positive: 'high quality anime illustration, expressive character design, clean line art, vibrant colors', negative: 'photograph, realistic skin, 3D render' },
  { id: 'fantasy', name: 'Фэнтези', positive: 'fantasy concept art, intricate details, magical atmosphere, rich color palette', negative: 'photograph, modern streetwear, blurry' },
  { id: 'oil', name: 'Масляная живопись', positive: 'traditional oil painting on canvas, visible brushstrokes, painterly texture, rich pigments', negative: 'photograph, digital glossy render' },
  { id: 'watercolor', name: 'Акварель', positive: 'delicate watercolor painting, watercolor paper texture, soft pigment washes, fluid edges', negative: 'photograph, heavy black outlines, 3D render' },
  { id: 'comic', name: 'Комикс', positive: 'graphic novel illustration, bold ink outlines, expressive composition, cel shading', negative: 'photorealistic, glossy 3D' },
  { id: 'pixel', name: 'Пиксель-арт', positive: 'pixel art, carefully placed pixels, limited color palette, crisp edges', negative: 'smooth shading, blurred details, photograph' },
  { id: '3d', name: '3D-арт', positive: 'beautiful stylized 3D render, detailed materials, global illumination, polished composition', negative: 'flat painting, crude geometry, noise' },
]);

export function normalizeStyles(value) {
  if (!Array.isArray(value)) return BUILTIN_STYLES.map(s => ({ ...s }));
  const rows = [];
  const seen = new Set();
  for (const raw of value.slice(0, 120)) {
    if (!raw || typeof raw !== 'object') continue;
    const name = String(raw.name ?? '').trim().slice(0, 80);
    const id = String(raw.id ?? '').trim().slice(0, 120);
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    rows.push({ id, name, positive: String(raw.positive ?? '').slice(0, 1200), negative: String(raw.negative ?? '').slice(0, 1000) });
  }
  return rows.length ? rows : BUILTIN_STYLES.map(s => ({ ...s }));
}
export function selectedStyle(settings) {
  const styles = normalizeStyles(settings.styles);
  return styles.find(st => st.id === settings.styleId) ?? styles[0];
}
export function composePrompt(text, style, extraPrefix = '') {
  const base = String(text ?? '').trim();
  if (!base) throw new Error('Промпт пустой');
  const prefix = [String(style?.positive ?? '').trim(), String(extraPrefix ?? '').trim()].filter(Boolean).join(', ');
  const result = prefix ? `${base}, ${prefix}` : base;
  if (result.length > 2000) throw new Error(`Длина промпта со стилем — ${result.length}. Максимум Perchance Bridge: 2000 символов. Сократи текст или стиль.`);
  return result;
}
export function composeNegative(base, style) {
  return [String(base || '').trim(), String(style?.negative || '').trim()].filter(Boolean).join(', ').slice(0, 1000);
}
