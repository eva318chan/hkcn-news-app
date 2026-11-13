-- Add extra_images to articles — run once in Supabase Dashboard → SQL Editor,
-- after 002_image_prompt.sql.
-- Stores additional real photos for an article as a JSON array of
-- {url, caption} objects, e.g. [{"url": "https://www.hkcnexpress.com/r2/design/202611/20261113-example-1.jpg", "caption": "圖片：香港賽馬會"}].
-- The hero image stays in image_url / image_caption; extra images render
-- below the summary on the article page (api/article-page.js).
-- Null/empty for articles with a single image (the common case).
alter table public.articles add column if not exists extra_images jsonb;
