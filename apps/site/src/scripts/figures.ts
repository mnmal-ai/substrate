/// <reference lib="dom" />
// Draws every [data-figure] element with the Hairline export it names. A card's figure plays its
// tour only while the card is hovered or holds focus; a page's figure answers the pointer.
import { cabinet, hub, query, rebuild, riffle, settle, slow } from '@lucasmarkes/hairline';
import type { FigureName } from '../lib/example-pages.ts';

const draw = { settle, rebuild, query, hub, cabinet, riffle, slow } satisfies Record<
  FigureName,
  unknown
>;

for (const el of document.querySelectorAll<HTMLElement>('[data-figure]')) {
  const make = draw[el.dataset.figure as FigureName];
  if (make === undefined) continue;
  const figure = make(el, { theme: 'dark' });
  const card = el.dataset.mode === 'card' ? el.closest<HTMLElement>('.card') : null;
  if (card === null) continue;
  let hovered = false;
  let focused = false;
  const sync = () => figure.update({ play: hovered || focused });
  card.addEventListener('pointerenter', () => {
    hovered = true;
    sync();
  });
  card.addEventListener('pointerleave', () => {
    hovered = false;
    sync();
  });
  card.addEventListener('focusin', () => {
    focused = true;
    sync();
  });
  card.addEventListener('focusout', (e) => {
    focused = card.contains(e.relatedTarget as Node | null);
    sync();
  });
}
