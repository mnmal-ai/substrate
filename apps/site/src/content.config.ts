import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const text = z.string().trim().min(1);

/** One Markdown file per worked example; its body holds the Elsewhere, On substrate and Where it stops sections. */
const examples = defineCollection({
  loader: glob({ pattern: '*.md', base: './src/content/examples' }),
  schema: z.object({
    order: z.number().int().min(1),
    name: text,
    promise: text,
    shows: z.tuple([text, text, text]),
    extras: z.array(z.enum(['three-ways', 'clickbench'])).default([])
  })
});

export const collections = { examples };
