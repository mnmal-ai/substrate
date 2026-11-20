/// <reference lib="dom" />
// Reveals each [data-reveal] block as it scrolls into view. Under reduced motion it does nothing,
// and base.css shows every block as it is.
if (
  matchMedia('(prefers-reduced-motion: no-preference)').matches &&
  'IntersectionObserver' in window
) {
  const seen = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add('in');
        seen.unobserve(e.target);
      }
    },
    { rootMargin: '0px 0px -10% 0px' }
  );
  for (const el of document.querySelectorAll('[data-reveal]')) seen.observe(el);
  document.documentElement.classList.add('reveal');
}
