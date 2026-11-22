/// <reference lib="dom" />
// Draws each [data-figure] element with the Hairline export it names, once it comes within 200px
// of the viewport. A card's figure plays its tour only while the card is hovered or holds focus;
// a page's figure answers the pointer.
import { cabinet, hub, query, rebuild, riffle, settle, sieve, slow } from '@lucasmarkes/hairline';
import type { FigureName } from '../lib/example-pages.ts';

const draw = { settle, sieve, rebuild, query, hub, cabinet, riffle, slow } satisfies Record<
  FigureName,
  unknown
>;

function mount(el: HTMLElement): void {
  const make = draw[el.dataset.figure as FigureName];
  if (make === undefined) return;
  const figure = make(el, { theme: 'dark' });
  const card = el.dataset.mode === 'card' ? el.closest<HTMLElement>('.card') : null;
  if (card === null) return;
  // A pointer or focus may already be inside the card when its figure mounts.
  let hovered = card.matches(':hover');
  let focused = card.matches(':focus-within');
  const sync = () => figure.update({ play: hovered || focused });
  sync();
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

const near = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      const el = entry.target as HTMLElement;
      // One batch can hold two entries for the same element.
      if (!entry.isIntersecting || el.dataset.mounted !== undefined) continue;
      el.dataset.mounted = '';
      near.unobserve(el);
      mount(el);
    }
  },
  { rootMargin: '200px' }
);
for (const el of document.querySelectorAll<HTMLElement>('[data-figure]')) near.observe(el);
